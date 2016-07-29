#!/usr/bin/env node
/**
 * Fairly generic cluster-based web service runner. Starts several instances
 * of a worker module (in this case the restface module), and manages restart
 * and graceful shutdown. The worker module can also be started independently,
 * which is especially useful for debugging.
 */
'use strict';

var cluster = require('cluster');
var Master = require('./lib/master');
var Worker = require('./lib/worker');

// Disable cluster RR balancing; direct socket sharing has better throughput /
// lower overhead. Also bump up somaxconn with this command:
// sudo sysctl -w net.core.somaxconn=4096
cluster.schedulingPolicy = cluster.SCHED_NONE;

// When forking, we should execute this script.
if (cluster.isMaster) {
    cluster.setupMaster({ exec: __filename });
}

function ServiceRunner(options) {
    if (cluster.isMaster) {
        this._impl = new Master(options);
    } else {
        this._impl = new Worker(options);
    }
}

ServiceRunner.prototype.start = function start(conf) {
    return this._impl.start(conf);
};

ServiceRunner.prototype.stop = function stop() {
    return this._impl.stop();
};

// @deprecated
ServiceRunner.prototype.run = function run(conf) {
    var self = this;
    return this.start(conf)
    .tap(function() {
        // Delay the log call until the logger is actually set up.
        if (self._impl._logger) {
            self._impl._logger.log('warn/service-runner',
                'ServiceRunner.run() is deprecated, and will be removed in v3.x.');
        }
    });
};

module.exports = ServiceRunner;

if (module.parent === null) {
    // Run as a script: Start up
    new ServiceRunner().start();
}
