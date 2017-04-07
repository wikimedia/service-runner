"use strict";

const P = require('bluebird');
const cluster = require('cluster');
const yaml = require('js-yaml');

const BaseService = require('./base_service');
const Worker = require('./worker');
const Logger = require('./logger');
const RateLimiterMaster = require('./ratelimiter').master;

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
        this.workerStatusMap = {};
    }

    _getConfigUpdateAction(conf) {
        return this._updateConfig(conf);
    }

    stop() {
        if (this.config.num_workers === 0) {
            // No workers needed, run worker code directly.
            return Worker.prototype.stop.call(this);
        }
        super.stop();
        if (this.interval) {
            clearInterval(this.interval);
        }
        this._shuttingDown = true;
        this._logger.log('info/service-runner/master', 'master shutting down, killing workers');
        return P.map(Object.keys(cluster.workers), this._stopWorker.bind(this));
    }

    _start() {
        if (this.config.num_workers === 0) {
            this.config.worker_id = 0;
            // No workers needed, run worker code directly.
            // FIXME: Create a Master / Worker dynamically on _start()?
            // Wrap to match _startWorkers
            return Worker.prototype._start.call(this).then(serviceReturns => [serviceReturns]);
        }

        // Fork workers.
        this._logger.log('info/service-runner',
            `master(${process.pid}) initializing ${this.config.num_workers} workers`);

        const shutdownMaster = () => {
            this.stop()
            .then(() => {
                this._logger.log('info/service-runner/master', 'Exiting master');
                process.exit(0);
            });
        };

        process.on('SIGINT', shutdownMaster);
        process.on('SIGTERM', shutdownMaster);

        // Set up rolling restarts
        process.on('SIGHUP', () => {
            this._firstWorkerStarted = false;
            this._firstWorkerStartupAttempts = 0;
            return this._updateConfig()
            .then(() => {
                // Recreate loggers
                this._logger.close();
                this._logger = new Logger(this.config.logging);
            })
            .then(this._rollingRestart.bind(this));
        });

        this._ratelimiter = new RateLimiterMaster(this.config.ratelimiter);

        return this._ratelimiter.setup()
        .then(() => this._startWorkers(this.config.num_workers))
        .tap(() => {
            this._logger.log('warn/service-runner', 'Startup finished');
            this._checkHeartbeat();
        });
    }

    _rollingRestart() {
        this._logger.log('info/service-runner/master', {
            message: 'SIGHUP received, performing rolling restart of workers'
        });
        this._inRollingRestart = true;
        P.each(Object.keys(cluster.workers), workerId => this._stopWorker(workerId)
        .then(() => this._startWorkers(1)))
        .then(() => {
            this._inRollingRestart = false;
        });
    }

    _stopWorker(workerId) {
        const worker = cluster.workers[workerId];
        if (!worker || worker.state === 'disconnected') {
            if (worker) {
                delete this.workerStatusMap[worker.process.pid];
            }
            return;
        }
        this.workerStatusMap[worker.process.pid] = {
            time: null,
            killed: true
        };
        const res = new P((resolve) => {
            const timeout = setTimeout(() => {
                // worker.kill doesn't send a signal immediately, it waits until
                // worker closes all connections with master. If after a minute
                // it didn't happen, don't expect it happen ever.
                worker.process.kill('SIGKILL');
                delete this.workerStatusMap[worker.process.pid];
                resolve();
            }, 60000);
            worker.once('disconnect', () => {
                clearTimeout(timeout);
                worker.process.kill('SIGKILL');
                delete this.workerStatusMap[worker.process.pid];
                resolve();
            });
        });
        worker.disconnect();
        return res;
    }

    _onStatusReceived(worker, status) {
        const val = this.workerStatusMap[worker.process.pid] || {};
        val.status = status;
        this.workerStatusMap[worker.process.pid] = val;
    }

    // Fork off one worker at a time, once the previous worker has finished
    // startup.
    _startWorkers(remainingWorkers, res, workerId) {
        res = res || [];
        if (remainingWorkers) {
            const worker = cluster.fork();
            this._saveBeat(worker);
            return new P((resolve) => {
                workerId = workerId || (this.config.num_workers - remainingWorkers + 1);
                const config = Object.assign({}, this.config, {
                    worker_id: workerId
                });
                worker.worker_id = workerId;
                worker.send({
                    type: 'config',
                    body: yaml.dump(config)
                });
                const startupWorkerExit = (code) => {
                    if (this._shuttingDown || this._inRollingRestart) {
                        return;
                    }

                    if (!this._firstWorkerStarted) {
                        this._logger.log('error/service-runner/master',
                            `First worker died on startup with exit code ${code}`);
                        if (this._firstWorkerStartupAttempts++ >= STARTUP_ATTEMPTS_LIMIT) {
                            // We tried to start the first worker 3 times, but never succeed.
                            // Give up.
                            this._logger.log('fatal/service-runner/master',
                                'startup failed, exiting master');
                            // Don't exit right away, allow logger to process message
                            setTimeout(() => {
                                process.exit(1);
                            }, 1000);
                            return;
                        }
                    }

                    if (this._firstWorkerStarted) {
                        this._logger.log('warn/service-runner/master',
                            `worker ${worker.process.pid} died during startup (${code}),`
                                + 'continue startup');
                    } else {
                        this._logger.log('warn/service-runner/master',
                            `worker ${worker.process.pid} died during startup (${code}),`
                                + ` continue startup attempt ${this._firstWorkerStartupAttempts}`);
                    }

                    // Let all the exit listeners fire before reassigning current worker ID
                    process.nextTick(() => {
                        resolve(this._startWorkers(remainingWorkers, res));
                    });
                };

                const workerExit = (worker) => {
                    if (this._shuttingDown || this._inRollingRestart) {
                        return;
                    }

                    const exitCode = worker.process.exitCode;
                    const info = {
                        message: `worker ${worker.process.pid} died (${exitCode}), restarting.`
                    };
                    if (this.workerStatusMap[worker.process.pid]
                        && this.workerStatusMap[worker.process.pid].status) {
                        info.status = this.workerStatusMap[worker.process.pid].status;
                    }
                    this._logger.log('error/service-runner/master', info);
                    delete this.workerStatusMap[worker.process.pid];
                    P.delay(Math.random() * 2000).then(() => {
                        this._startWorkers(1, undefined, worker.worker_id);
                    });
                };

                worker.on('exit', startupWorkerExit);
                worker.on('message', (msg) => {
                    switch (msg.type) {
                    case 'startup_finished':
                        worker.removeListener('exit', startupWorkerExit);
                        worker.on('exit', () => { workerExit(worker); });
                        this._firstWorkerStarted = true;
                        res.push(msg.serviceReturns);
                        resolve(this._startWorkers(--remainingWorkers, res));
                        break;
                    case 'heartbeat':
                        this._saveBeat(worker);
                        break;
                    case 'service_status':
                        this._onStatusReceived(worker, msg.status);
                        break;
                    case 'ratelimiter_counters':
                        return this._ratelimiter
                            && this._ratelimiter.updateCounters(msg.value);
                    default:
                        this._logger.log('error/service-runner/master',
                            `unknown message type received from worker ${msg.type}`);
                    }
                });
            });
        } else {
            return res;
        }
    }

    /**
     * Checks times of the heartbeats for each worker
     * killing workers that were inactive for too long
     * @private
     */
    _checkHeartbeat() {
        this.interval = setInterval(() => {
            if (!this._shuttingDown && !this._inRollingRestart) {
                const now = new Date();
                Object.keys(cluster.workers).forEach((workerId) => {
                    const worker = cluster.workers[workerId];
                    const lastBeat = this.workerStatusMap[worker.process.pid];
                    if (!lastBeat || (!lastBeat.killed && now - lastBeat.time
                            > this.config.worker_heartbeat_timeout)) {
                        const info = {};
                        info.message =
                            `worker ${worker.process.pid} stopped sending heartbeats, killing.`;
                        if (lastBeat && lastBeat.status) {
                            info.status = lastBeat.status;
                        }
                        this._logger.log('error/service-runner/master', info);
                        this._stopWorker(workerId);
                        // Don't need to respawn a worker, it will be restarted upon 'exit' event
                    }
                });
            }
        }, this.config.worker_heartbeat_timeout / 2 + 1);
    }

    /**
     * Saves the timestamp of a worker heartbeat
     * @private
     */
    _saveBeat(worker) {
        const currentVal = this.workerStatusMap[worker.process.pid];
        if (currentVal && currentVal.killed) {
            return;
        }
        this.workerStatusMap[worker.process.pid] = currentVal || {};
        this.workerStatusMap[worker.process.pid].time = new Date();
        this.workerStatusMap[worker.process.pid].killed = false;
    }
}

module.exports = Master;
