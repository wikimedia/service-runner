#!/usr/bin/env node
/**
 * Fairly generic cluster-based web service runner. Starts several instances
 * of a worker module (in this case the restface module), and manages restart
 * and graceful shutdown. The worker module can also be started independently,
 * which is especially useful for debugging.
 */
'use strict';

// Upgrade to es6
require('core-js/shim');

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

ServiceRunner.prototype.run = function run(conf) {
    return this._impl.run(conf);
};


module.exports = ServiceRunner;

if (module.parent === null) {
    // Run as a script: Start up
    new ServiceRunner().run();
}
