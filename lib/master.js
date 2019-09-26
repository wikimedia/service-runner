'use strict';

const P = require('bluebird');
const cluster = require('cluster');
const yaml = require('js-yaml');

const BaseService = require('./base_service');
const Worker = require('./worker');
const Logger = require('./logger');
const RateLimiterMaster = require('./ratelimiter').master;
const PrometheusServer = require('./metrics/servers/prometheus');

/**
 * Maximum number of startup attempts. In case the first worker
 * startup fails more then limit times, master is killed with
 * exit code 1.
 *
 * @const
 * @type {number}
 */
const STARTUP_ATTEMPTS_LIMIT = 3;

/**
 * Master class, inherits from BaseService.
 * Contains logic that run in the master process.
 *
 * @constructor
 */
class Master extends BaseService {
    constructor(options) {
        super(options);

        // Is the master shutting down?
        this._shuttingDown = false;
        // Are we performing a rolling restart?
        this._inRollingRestart = false;
        this._firstWorkerStarted = false;
        this._firstWorkerStartupAttempts = 0;
        this._workerStatusMap = {};
        this.prometheusServer = null;
        this._shutdownMasterHandler = () => {
            this.stop()
            .then(() => {
                this._logger.log('info/service-runner/master', 'Exiting master');
                return this._exitProcess(0);
            });
        };

        this._rollingRestartHandler = () => {
            this._firstWorkerStarted = false;
            this._firstWorkerStartupAttempts = 0;
            return this._updateConfig()
            .then(() => {
                // Recreate loggers
                this._logger.close();
                this._logger = new Logger(this.config.logging);
            })
            .then(this._rollingRestart.bind(this));
        };
    }

    _getConfigUpdateAction(conf) {
        return this._updateConfig(conf);
    }

    stop() {
        if (this.prometheusServer) {
            this.prometheusServer.close();
        }
        if (this.config.num_workers === 0) {
            // No workers needed, run worker code directly.
            return Worker.prototype.stop.call(this);
        }

        // Remove signal handlers
        process.removeListener('SIGINT', this._shutdownMasterHandler);
        process.removeListener('SIGTERM', this._shutdownMasterHandler);
        process.removeListener('SIGHUP', this._rollingRestartHandler);

        super.stop();
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
        this._shuttingDown = true;
        this._logger.log('info/service-runner/master', 'master shutting down, killing workers');
        return P.map(Object.keys(cluster.workers), this._stopWorker.bind(this));
    }

    _start() {
        // Start Prometheus Metrics Endpoint
        const prometheus_config = this.config.metrics.find((o) => {
            return o.type === 'prometheus';
        });
        if (prometheus_config) {
            this.prometheusServer = new PrometheusServer(
                prometheus_config,
                this.config.num_workers
            );
        }

        if (this.config.num_workers === 0) {
            this.config.worker_id = 0;
            // No workers needed, run worker code directly.
            // FIXME: Create a Master / Worker dynamically on _start()?
            // Wrap to match _startWorkers
            return Worker.prototype._start.call(this)
            .then((serviceReturns) => [serviceReturns]);
        }

        // Fork workers.
        this._logger.log('info/service-runner',
            `master(${process.pid}) initializing ${this.config.num_workers} workers`);

        process.on('SIGINT', this._shutdownMasterHandler);
        process.on('SIGTERM', this._shutdownMasterHandler);

        // Set up rolling restarts
        process.on('SIGHUP', this._rollingRestartHandler);

        let ratelimiterSetup = P.resolve();
        if (this.config.ratelimiter) {
            this._ratelimiter = new RateLimiterMaster(this.config.ratelimiter);
            ratelimiterSetup = this._ratelimiter.setup();
        }
        return ratelimiterSetup
        .then(() => this._startWorkers(this.config.num_workers))
        .tap(() => {
            this._logger.log('warn/service-runner', 'startup finished');
            this._setupHeartbeatCheck();
        });

    }

    _rollingRestart() {
        this._logger.log('info/service-runner/master', {
            message: 'SIGHUP received, performing rolling restart of workers'
        });
        this._inRollingRestart = true;
        P.each(Object.keys(cluster.workers), (workerPid) => {
            const workerId = cluster.workers[workerPid].worker_id;
            return this._stopWorker(workerPid)
            .then(() => this._startWorker(workerId));
        })
        .then(() => {
            this._inRollingRestart = false;
        });
    }

    _stopWorker(workerPid) {
        const worker = cluster.workers[workerPid];

        if (!worker || worker.state === 'disconnected') {
            if (worker) {
                delete this._workerStatusMap[worker.process.pid];
            }
            return;
        }
        this._workerStatusMap[worker.process.pid] = {
            time: null,
            killed: true
        };

        const res = new P((resolve) => {
            const timeout = setTimeout(() => {
                // worker.kill doesn't send a signal immediately, it waits until
                // worker closes all connections with master. If after a minute
                // it didn't happen, don't expect it happen ever.
                worker.process.kill('SIGKILL');
                delete this._workerStatusMap[worker.process.pid];
                resolve();
            }, 60000);
            worker.once('disconnect', () => {
                clearTimeout(timeout);
                delete this._workerStatusMap[worker.process.pid];
                resolve();
            });
        });
        worker.disconnect();
        return res;
    }

    _onStatusReceived(worker, status) {
        const val = this._workerStatusMap[worker.process.pid] || {};
        val.status = status;
        this._workerStatusMap[worker.process.pid] = val;
    }

    _startWorker(workerId) {
        const worker = cluster.fork();
        this._saveBeat(worker);
        return new P((resolve) => {
            const config = Object.assign({}, this.config, {
                worker_id: workerId
            });
            worker.worker_id = workerId;
            worker.send({
                type: 'config',
                body: yaml.dump(config)
            });

            let workerMessageHandler = null;

            const startupWorkerExitHandler = (code) => {
                if (this._shuttingDown || this._inRollingRestart) {
                    return;
                }

                worker.removeListener('exit', startupWorkerExitHandler);
                worker.removeListener('message', workerMessageHandler);

                if (!this._firstWorkerStarted &&
                        this._firstWorkerStartupAttempts++ >= STARTUP_ATTEMPTS_LIMIT) {
                    // We tried to start the first worker 3 times, but never succeed.
                    // Give up.
                    this._logger.log('fatal/service-runner/master', {
                        message: 'startup failed, exiting master',
                        worker_pid: worker.process.pid,
                        exit_code: code
                    });

                    return this._exitProcess(1);
                }

                if (this._firstWorkerStarted) {
                    this._logger.log('warn/service-runner/master', {
                        message: 'worker died during startup, continue startup',
                        exit_code: code,
                        worker_pid: worker.process.pid
                    });
                } else {
                    this._logger.log('warn/service-runner/master', {
                        message: 'first worker died during startup, continue startup',
                        worker_pid: worker.process.pid,
                        exit_code: code,
                        startup_attempt: this._firstWorkerStartupAttempts
                    });
                }
                P.delay(Math.random() * 2000).then(() => {
                    resolve(this._startWorker(workerId));
                });
            };
            worker.on('exit', startupWorkerExitHandler);

            const workerExitHandler = (worker) => {
                if (this._shuttingDown || this._inRollingRestart) {
                    return;
                }

                const info = {
                    message: 'worker died, restarting',
                    worker_pid: worker.process.pid,
                    exit_code: worker.process.exitCode
                };
                if (this._workerStatusMap[worker.process.pid] &&
                    this._workerStatusMap[worker.process.pid].status) {
                    info.status = this._workerStatusMap[worker.process.pid].status;
                }
                this._logger.log('error/service-runner/master', info);
                delete this._workerStatusMap[worker.process.pid];
                worker.removeListener('exit', workerExitHandler);
                worker.removeListener('message', workerMessageHandler);

                P.delay(Math.random() * 2000).then(() => {
                    resolve(this._startWorker(worker.worker_id));
                });
            };

            workerMessageHandler = (msg) => {
                switch (msg.type) {
                    case 'startup_finished':
                        worker.removeListener('exit', startupWorkerExitHandler);
                        worker.on('exit', () => {
                            workerExitHandler(worker);
                        });
                        this._firstWorkerStarted = true;
                        resolve(msg.serviceReturns);
                        break;
                    case 'heartbeat':
                        this._saveBeat(worker);
                        break;
                    case 'service_status':
                        this._onStatusReceived(worker, msg.status);
                        break;
                    case 'ratelimiter_counters':
                        return this._ratelimiter &&
                                this._ratelimiter.updateCounters(msg.value);
                    case 'prom-client:getMetricsRes':
                        return; // Ignore prom-client internal communication.
                    default:
                        this._logger.log('error/service-runner/master',
                            `unknown message type received from worker ${msg.type}`);
                }
            };

            worker.on('message', workerMessageHandler);
        });
    }
    // Fork a single worker, wait for it to start executing and set everything up,
    // and then fork all the rest of the workers.
    _startWorkers(workersToStart) {
        return this._startWorker(1)
        .then((firstReturn) => P.map(
            Array.from(new Array(workersToStart - 1), (val, i) => i + 2),
            (workerId) => this._startWorker(workerId),
            { concurrency: this.config.startup_concurrency })
        .then((results) => [firstReturn].concat(results)));
    }

    /**
     * Checks times of the heartbeats for each worker
     * killing workers that were inactive for too long
     * @private
     */
    _setupHeartbeatCheck() {
        if (this.config.worker_heartbeat_timeout === false) {
            return;
        }
        this.interval = setInterval(() => {
            if (!this._shuttingDown && !this._inRollingRestart) {
                const now = new Date();
                Object.keys(cluster.workers).forEach((workerPid) => {
                    const worker = cluster.workers[workerPid];
                    const lastBeat = this._workerStatusMap[worker.process.pid];
                    if (!lastBeat || (!lastBeat.killed && now - lastBeat.time >
                            this.config.worker_heartbeat_timeout)) {
                        const info = {
                            message: 'worker stopped sending heartbeats, killing.',
                            worker_pid: worker.process.pid
                        };
                        if (lastBeat && lastBeat.status) {
                            info.status = lastBeat.status;
                        }
                        this._logger.log('error/service-runner/master', info);
                        this._stopWorker(workerPid);
                        // Don't need to respawn a worker, it will be restarted upon 'exit' event
                    }
                });
            }
        }, this.config.worker_heartbeat_timeout / 2 + 1);
    }

    /**
     * Saves the timestamp of a worker heartbeat
     * @param {Object} worker
     * @private
     */
    _saveBeat(worker) {
        const currentVal = this._workerStatusMap[worker.process.pid];
        if (currentVal && currentVal.killed) {
            return;
        }
        this._workerStatusMap[worker.process.pid] = currentVal || {};
        this._workerStatusMap[worker.process.pid].time = new Date();
        this._workerStatusMap[worker.process.pid].killed = false;
    }
}

module.exports = Master;
