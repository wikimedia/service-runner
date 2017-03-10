"use strict";

var P = require('bluebird');
var util = require('util');
var cluster = require('cluster');
var yaml = require('js-yaml');
var semver = require('semver');

var BaseService = require('./base_service');
var Worker = require('./worker');
var Logger = require('./logger');
var RateLimiterMaster = require('./ratelimiter').master;

/**
 * Maximum number of startup attempts. In case the first worker
 * startup fails more then limit times, master is killed with
 * exit code 1.
 *
 * @const
 * @type {number}
 */
var STARTUP_ATTEMPTS_LIMIT = 3;

/**
 * Master class, inherits from BaseService.
 * Contains logic that run in the master process.
 *
 * @constructor
 */
function Master(options) {
    BaseService.call(this, options);

    // Is the master shutting down?
    this._shuttingDown = false;
    // Are we performing a rolling restart?
    this._inRollingRestart = false;
    this._firstWorkerStarted = false;
    this._firstWorkerStartupAttempts = 0;
    this.workerStatusMap = {};
}

util.inherits(Master, BaseService);

Master.prototype._getConfigUpdateAction = function(conf) {
    return this._updateConfig(conf);
};

Master.prototype.stop = function() {
    var self = this;
    if (self.config.num_workers === 0) {
        // No workers needed, run worker code directly.
        return Worker.prototype.stop.call(self);
    }
    BaseService.prototype.stop.call(self);
    self._shuttingDown = true;
    self._logger.log('info/service-runner/master', 'master shutting down, killing workers');
    return P.map(Object.keys(cluster.workers), self._stopWorker.bind(self));
};

Master.prototype._start = function() {
    var self = this;

    if (self.config.num_workers === 0) {
        self.config.worker_id = 0;
        // No workers needed, run worker code directly.
        // FIXME: Create a Master / Worker dynamically on _start()?
        return Worker.prototype._start.call(self).then(function(serviceReturns) {
            // Wrap to match _startWorkers
            return [serviceReturns];
        });
    }

    // Fork workers.
    this._logger.log('info/service-runner', 'master(' + process.pid + ') initializing '
        + this.config.num_workers + ' workers');

    function shutdownMaster() {
        self.stop()
        .then(function() {
            self._logger.log('info/service-runner/master', 'Exiting master');
            process.exit(0);
        });
    }

    process.on('SIGINT', shutdownMaster);
    process.on('SIGTERM', shutdownMaster);

    // Set up rolling restarts
    process.on('SIGHUP', function() {
        self._firstWorkerStarted = false;
        self._firstWorkerStartupAttempts = 0;
        return self._updateConfig()
        .then(function() {
            // Recreate loggers
            self._logger.close();
            self._logger = new Logger(self.config.logging);
        })
        .then(self._rollingRestart.bind(self));
    });

    self._ratelimiter = new RateLimiterMaster(self.config.ratelimiter);

    return self._ratelimiter.setup()
    .then(function() {
        return self._startWorkers(self.config.num_workers);
    })
    .tap(function() {
        self._logger.log('warn/service-runner', 'Startup finished');
        self._checkHeartbeat();
    });
};

Master.prototype._rollingRestart = function() {
    this._logger.log('info/service-runner/master', {
        message: 'SIGHUP received, performing rolling restart of workers'
    });
    var self = this;
    self._inRollingRestart = true;
    P.each(Object.keys(cluster.workers), function(workerId) {
        return self._stopWorker(workerId)
        .then(function() {
            return self._startWorkers(1);
        });
    })
    .then(function() {
        self._inRollingRestart = false;
    });
};

Master.prototype._stopWorker = function(workerId) {
    var self = this;
    var worker = cluster.workers[workerId];
    if (!worker || worker.state === 'disconnected') {
        if (worker) {
            delete self.workerStatusMap[worker.process.pid];
        }
        return;
    }
    self.workerStatusMap[worker.process.pid] = {
        time: null,
        killed: true
    };
    var res = new P(function(resolve) {
        var timeout = setTimeout(function() {
            // worker.kill doesn't send a signal immediately, it waits until
            // worker closes all connections with master. If after a minute
            // it didn't happen, don't expect it happen ever.
            worker.process.kill('SIGKILL');
            delete self.workerStatusMap[worker.process.pid];
            resolve();
        }, 60000);
        worker.once('disconnect', function() {
            clearTimeout(timeout);
            worker.process.kill('SIGKILL');
            delete self.workerStatusMap[worker.process.pid];
            resolve();
        });
    });
    worker.disconnect();
    return res;
};

/*
 This is a workaround for the following bug in node:
 https://github.com/joyent/node/issues/9409

 Shortly, the problem is that a worker is removed by master
 if it sends 'disconnect' and then it's checked on 'exit'.
 However, in some cases (for example an infinite CPU loop in worker,
 'disconnect' may never happen, and master will crash receiving an 'exit'
 */
function fixCloseDisconnectListeners(worker) {
    if (semver.gte(process.version, '4.2.2')) { return; }

    var exit = worker.process.listeners('exit')[0].listener;
    var disconnect = worker.process.listeners('disconnect')[0].listener;

    // Now replace the exit listener to make sure 'disconnect' was called
    worker.process.removeListener('exit', exit);
    worker.process.once('exit', function() {
        if (worker.state !== 'disconnected') {
            disconnect();
        }
        exit.apply(this, arguments);
    });
}

Master.prototype._onStatusReceived = function(worker, status) {
    var self = this;
    var val = self.workerStatusMap[worker.process.pid] || {};
    val.status = status;
    self.workerStatusMap[worker.process.pid] = val;
};

// Fork off one worker at a time, once the previous worker has finished
// startup.
Master.prototype._startWorkers = function(remainingWorkers, res, workerId) {
    res = res || [];
    var self = this;
    if (remainingWorkers) {
        var worker = cluster.fork();
        self._currentStartingWorker = worker.process.pid;
        self._saveBeat(worker);
        return new P(function(resolve) {
            fixCloseDisconnectListeners(worker);
            workerId = workerId || (self.config.num_workers - remainingWorkers + 1);
            var config = Object.assign({}, self.config, {
                worker_id: workerId
            });
            worker.worker_id = workerId;
            worker.send({
                type: 'config',
                body: yaml.dump(config)
            });
            var startupWorkerExit = function(code) {
                if (self._shuttingDown || self._inRollingRestart) {
                    return;
                }

                if (!self._firstWorkerStarted) {
                    self._logger.log('error/service-runner/master',
                        `First worker died on startup with exit code ${code}`);
                    if (self._firstWorkerStartupAttempts++ >= STARTUP_ATTEMPTS_LIMIT) {
                        // We tried to start the first worker 3 times, but never succeed. Give up.
                        self._logger.log('fatal/service-runner/master',
                            'startup failed, exiting master');
                        // Don't exit right away, allow logger to process message
                        setTimeout(function() { process.exit(1); }, 1000);
                        return;
                    }
                }

                if (self._firstWorkerStarted) {
                    self._logger.log('warn/service-runner/master', 'worker ' + worker.process.pid
                        + ' died during startup (' + code + '), continue startup');
                } else {
                    self._logger.log('warn/service-runner/master', 'worker ' + worker.process.pid
                        + ' died during startup (' + code
                        + '), continue startup attempt ' + self._firstWorkerStartupAttempts);
                }

                // Let all the exit listeners fire before reassigning current worker ID
                process.nextTick(function() {
                    resolve(self._startWorkers(remainingWorkers, res));
                });
            };

            var workerExit = function(worker) {
                if (self._shuttingDown || self._inRollingRestart) {
                    return;
                }

                var exitCode = worker.process.exitCode;
                var info = {
                    message: 'worker ' + worker.process.pid
                        + ' died (' + exitCode + '), restarting.'
                };
                if (self.workerStatusMap[worker.process.pid]
                    && self.workerStatusMap[worker.process.pid].status) {
                    info.status = self.workerStatusMap[worker.process.pid].status;
                }
                self._logger.log('error/service-runner/master', info);
                delete self.workerStatusMap[worker.process.pid];
                P.delay(Math.random() * 2000).then(function() {
                    self._startWorkers(1, undefined, worker.worker_id);
                });
            };

            worker.on('exit', startupWorkerExit);
            worker.on('message', function(msg) {
                switch (msg.type) {
                    case 'startup_finished':
                        worker.removeListener('exit', startupWorkerExit);
                        worker.on('exit', function() { workerExit(worker); });
                        self._firstWorkerStarted = true;
                        res.push(msg.serviceReturns);
                        resolve(self._startWorkers(--remainingWorkers, res));
                        break;
                    case 'heartbeat':
                        self._saveBeat(worker);
                        break;
                    case 'service_status':
                        self._onStatusReceived(worker, msg.status);
                        break;
                    case 'ratelimiter_counters':
                        return self._ratelimiter
                            && self._ratelimiter.updateCounters(msg.value);
                    default:
                        self._logger.log('error/service-runner/master',
                            'unknown message type received from worker ' + msg.type);
                }
            });
        });
    } else {
        return res;
    }
};

/**
 * Checks times of the heartbeats for each worker
 * killing workers that were inactive for too long
 * @private
 */
Master.prototype._checkHeartbeat = function() {
    var self = this;
    self.interval = setInterval(function() {
        if (!self._shuttingDown && !self._inRollingRestart) {
            var now = new Date();
            Object.keys(cluster.workers).forEach(function(workerId) {
                var worker = cluster.workers[workerId];
                var lastBeat = self.workerStatusMap[worker.process.pid];
                if (!lastBeat || (!lastBeat.killed && now - lastBeat.time
                        > self.config.worker_heartbeat_timeout)) {
                    var info = {
                        message: 'worker ' + worker.process.pid
                            + ' stopped sending heartbeats, killing.'
                    };
                    if (lastBeat && lastBeat.status) {
                        info.status = lastBeat.status;
                    }
                    self._logger.log('error/service-runner/master', info);
                    self._stopWorker(workerId);
                    // Don't need to respawn a worker, it will be restarted upon 'exit' event
                }
            });
        }
    }, self.config.worker_heartbeat_timeout / 2 + 1);
};

/**
 * Saves the timestamp of a worker heartbeat
 * @private
 */
Master.prototype._saveBeat = function(worker) {
    var self = this;
    var currentVal = self.workerStatusMap[worker.process.pid];
    if (currentVal && currentVal.killed) {
        return;
    }
    self.workerStatusMap[worker.process.pid] = currentVal || {};
    self.workerStatusMap[worker.process.pid].time = new Date();
    self.workerStatusMap[worker.process.pid].killed = false;
};

module.exports = Master;
