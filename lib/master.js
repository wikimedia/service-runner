"use strict";

var P = require('bluebird');
var util = require('util');
var cluster = require('cluster');
var yaml = require('js-yaml');
var semver = require('semver');

var BaseService = require('./base_service');
var Worker = require('./worker');
var Logger = require('./logger');

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
    this.workerStatusMap = {};
}

util.inherits(Master, BaseService);

Master.prototype._getConfigUpdateAction = function(conf) {
    return this._updateConfig(conf);
};

Master.prototype._run = function() {
    var self = this;

    if (self.config.num_workers === 0) {
        // No workers needed, run worker code directly.
        return Worker.prototype._run.call(self);
    }

    // Fork workers.
    this._logger.log('info/service-runner', 'master(' + process.pid + ') initializing '
        + this.config.num_workers + ' workers');

    cluster.on('exit', function(worker, code, signal) {
        if (!self._shuttingDown && !self._inRollingRestart) {
            var exitCode = worker.process.exitCode;
            var info = {
                message: 'worker ' + worker.process.pid + ' died (' + exitCode + '), restarting.'
            };
            if (self.workerStatusMap[worker.process.pid]
                    && self.workerStatusMap[worker.process.pid].status) {
                info.status = self.workerStatusMap[worker.process.pid].status;
            }
            self._logger.log('error/service-runner/master', info);
            delete self.workerStatusMap[worker.process.pid];
            P.delay(Math.random() * 2000).then(function() { self._startWorkers(1); });
        }
    });

    var shutdownMaster = function() {
        self._shuttingDown = true;
        self._logger.log('info/service-runner/master', 'master shutting down, killing workers');
        if (self.interval) {
            clearInterval(self.interval);
        }
        P.map(Object.keys(cluster.workers), self._stopWorker.bind(self))
        .then(function() {
            self._logger.log('info/service-runner/master', 'Exiting master');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdownMaster);
    process.on('SIGTERM', shutdownMaster);

    // Set up rolling restarts
    process.on('SIGHUP', function() {
        return self._updateConfig()
        .then(function() {
            // Recreate loggers
            self._logger.close();
            self._logger = new Logger(self.config.logging);
        })
        .then(self._rollingRestart.bind(self));
    });

    return this._startWorkers(this.config.num_workers)
    .then(function(workers) {
        self._checkHeartbeat();
        return workers;
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
    if (worker.state === 'disconnected') {
        delete self.workerStatusMap[worker.process.pid];
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
Master.prototype._startWorkers = function(remainingWorkers) {
    var self = this;
    if (remainingWorkers) {
        var worker = cluster.fork();
        self._saveBeat(worker);
        return new P(function(resolve) {
            fixCloseDisconnectListeners(worker);
            worker.send({
                type: 'config',
                body: yaml.dump(self.config)
            });
            worker.on('message', function(msg) {
                switch (msg.type) {
                    case 'startup_finished':
                        resolve(self._startWorkers(--remainingWorkers));
                        break;
                    case 'heartbeat':
                        self._saveBeat(worker);
                        break;
                    case 'service_status':
                        self._onStatusReceived(worker, msg.status);
                        break;
                    default:
                        self._logger.log('error/service-runner/master',
                            'unknown message type received from worker ' + msg.type);
                }
            });
        });
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
                    if (lastBeat.status) {
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
