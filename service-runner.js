#!/usr/bin/env node

'use strict';

/**
 * Fairly generic cluster-based web service runner. Starts several instances
 * of a worker module (in this case the restface module), and manages restart
 * and graceful shutdown. The worker module can also be started independently,
 * which is especially useful for debugging.
 */

const cluster = require('cluster');
const Master = require('./lib/master');
const Worker = require('./lib/worker');
const Logger = require('./lib/logger');
const makeMetrics = require('./lib/metrics');
const P = require('bluebird');

// Disable cluster RR balancing; direct socket sharing has better throughput /
// lower overhead. Also bump up somaxconn with this command:
// sudo sysctl -w net.core.somaxconn=4096
// Higher throughput, but worse load distribution can be achieved with:
// cluster.schedulingPolicy = cluster.SCHED_NONE;

// When forking, we should execute this script.
if (cluster.isMaster) {
    cluster.setupMaster({ exec: __filename });
}

class ServiceRunner {
    constructor(options) {
        if (cluster.isMaster) {
            this._impl = new Master(options);
        } else {
            this._impl = new Worker(options);
        }
    }

    start(conf) {
        return this._impl.start(conf);
    }

    stop() {
        return this._impl.stop();
    }

    // @deprecated
    run(conf) {
        return this.start(conf)
        .tap(() => {
            // Delay the log call until the logger is actually set up.
            if (this._impl._logger) {
                this._impl._logger.log('warn/service-runner',
                    'ServiceRunner.run() is deprecated, and will be removed in v3.x.');
            }
        });
    }

    static getLogger(loggerConf) { return new Logger(loggerConf); }
    static getMetrics(metricsConf, logger) { return makeMetrics(metricsConf, logger); }
}

module.exports = ServiceRunner;

if (module.parent === null) {
    // Cancellable promises have to enabled before we instantiate any promises. Because
    // ServiceRunner heavily relies on promises this is the best place to leave the config
    // like that.
    if (process.env.APP_ENABLE_CANCELLABLE_PROMISES) {
        P.config({
            cancellation: true
        });
    }
    // Run as a script: Start up
    new ServiceRunner().start();
}
