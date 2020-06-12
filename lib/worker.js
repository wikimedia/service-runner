'use strict';

const P = require('bluebird');
const cluster = require('cluster');
const path = require('path');

const makeMetrics = require('./metrics');
const BaseService = require('./base_service');
const HeapWatch = require('./heapwatch');
const RateLimiterWorker = require('./ratelimiter').worker;
const RateLimiterNoCluster = require('./ratelimiter').nocluster;

/**
 * Worker class, inherits from BaseService.
 * Contains logic that runs on a worker process.
 *
 * (Note: if num_workers is zero, no forks are created,
 *  so this code runs on master process)
 *
 * @constructor
 */
class Worker extends BaseService {
    constructor() {
        super();

        this._dumpHeapHandler = null;
        this._messageHandler = null;
        this._serviceStatusHandler = null;
    }

    _getConfigUpdateAction() {
        return new P((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timeout waiting for config in worker ${process.pid}`));
            }, 3000);
            process.on('message', this._messageHandler = (message) => {
                if (message.type === 'config') {
                    clearTimeout(timeout);
                    this._updateConfig(message.body)
                    .then(resolve);
                } else if (message.type === 'ratelimiter_blocks') {
                    if (this._ratelimiter) {
                        this._ratelimiter._updateBlocks(message.value);
                    }
                } else {
                    reject(new Error(`Invalid message received: ${JSON.stringify(message)}`));
                }
            });

            if (cluster.isWorker) {
                // If got a status update in a worker - forward it to the master
                process.on('service_status', this._serviceStatusHandler = (message) => {
                    try {
                        process.send({
                            type: 'service_status',
                            status: message
                        });
                    } catch (e) {
                        this._logger.log('warn/service-runner/worker/', {
                            msg: 'error sending worker status update',
                            err: e
                        });
                    }
                });
            }
        });
    }

    stop() {
        super.stop();

        this._logger.log('info/service-runner/worker', {
            message: 'worker shutting down',
            worker_pid: process.pid
        });

        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
        this._metrics.close();
        this._heapwatchHandle.close();

        // Remove signal handlers
        if (this._dumpHeapHandler) {
            process.removeListener('SIGUSR2', this._dumpHeapHandler);
            this._dumpHeapHandler = null;
        }
        if (this._serviceStatusHandler) {
            process.removeListener('service_status', this._serviceStatusHandler);
            this._serviceStatusHandler = null;
        }
        if (this._messageHandler) {
            process.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }

        if (Array.isArray(this._serviceReturns)) {
            return P.each(this._serviceReturns, (serviceRet) => {
                if (serviceRet && typeof serviceRet.close === 'function') {
                    return serviceRet.close();
                }
            });
        } else {
            return P.resolve();
        }
    }

    _start() {
        if (cluster.isWorker) {
            cluster.worker.on('disconnect', () =>
                this.stop()
                .then(() => this._exitProcess(0)));
        }

        // Enable heap dumps in /tmp on kill -USR2.
        // See https://github.com/bnoordhuis/node-heapdump/
        // For node 0.6/0.8: npm install heapdump@0.1.0
        // For 0.10: npm install heapdump
        process.on('SIGUSR2', this._dumpHeapHandler = () => {
            try {
                const heapdump = require('heapdump');
                const cwd = process.cwd();
                console.error('SIGUSR2 received! Writing snapshot.');
                process.chdir('/tmp');
                heapdump.writeSnapshot();
                process.chdir(cwd);
            } catch (e) {
                this._logger.log('warn/service-runner/worker', {
                    message: 'worker received SIGUSR2, but heapdump is not installed',
                    worker_pid: process.pid
                });
            }

            // Also switch on trace logging for 5 seconds
            console.error('switching on trace logging for 5 seconds.');
            this._logger.constructor.logTrace = true;
            setTimeout(() => {
                console.error('switching trace logging off.');
                this._logger.constructor.logTrace = false;
            }, 5000);
        });

        // Metrics reporting
        this._metrics = makeMetrics(this.config.metrics, this._logger);
        // Heap limiting
        // We try to restart workers before they get slow
        // Default to something close to the default node 2g limit
        const limitMB = parseInt(this.config.worker_heap_limit_mb, 10) || 1500;
        this._heapwatchHandle = new HeapWatch({ limitMB }, this._logger, this._metrics);
        this._heapwatchHandle.watch();
        this._heapwatchHandle.setGCMonitor();

        if (cluster.isWorker) {
            this._setupWorkerHeartBeat();
        }

        // Rate limiting.
        if (this.config.ratelimiter) {
            if (cluster.isWorker) {
                this._ratelimiter = new RateLimiterWorker(this.config.ratelimiter);
            } else {
                this._ratelimiter = new RateLimiterNoCluster(this.config.ratelimiter);
                this._ratelimiter.setup();
            }
        }

        // Require service modules and start them
        return P.map(this.config.services, (service) => {
            const name = service.name || service.module;
            let basePath;
            if (service.app_base_path) {
                basePath = path.resolve(this._basePath, service.app_base_path);
            } else {
                basePath = this._basePath;
            }
            ['worker_id', 'logging', 'metrics', 'num_workers'].forEach((k) => {
                service.conf[k] = this.config[k];
            });
            const opts = {
                name,
                appBasePath: basePath,
                config: service.conf,
                logger: this._logger.child({
                    name
                }),
                // todo: set up custom prefix
                metrics: this._metrics,
                ratelimiter: this._ratelimiter
            };

            return this._requireModule(service.module || service.name)
            .then((svcMod) => {
                return service.entrypoint ?
                    svcMod[service.entrypoint](opts) : svcMod(opts);
            });
        })
        .then((res) => {
            let ret = res;
            this._serviceReturns = res;
            // Signal that this worker finished startup
            if (cluster.isWorker) {
                // Make sure that only JSON-serializable values are returned.
                try {
                    ret = JSON.parse(JSON.stringify(res));
                } catch (e) {
                    ret = [e];
                }
                process.send({ type: 'startup_finished', serviceReturns: ret });
            }
            return ret;
        })
        .catch((e) => {
            this._logger.log('fatal/service-runner/worker', e);
            return this._exitProcess(1);
        });
    }

    _setupWorkerHeartBeat() {
        if (this.config.worker_heartbeat_timeout === false) {
            return;
        }
        // We send heart beat 3 times more frequently than check it
        // to avoid possibility of wrong restarts
        if (this._running) {
            process.send({ type: 'heartbeat' });
        }
        this.interval = setInterval(() => {
            if (this._running) {
                process.send({ type: 'heartbeat' });
            }
        }, this.config.worker_heartbeat_timeout / 3);
    }
}

module.exports = Worker;
