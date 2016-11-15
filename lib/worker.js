"use strict";

var P = require('bluebird');
var util = require('util');
var cluster = require('cluster');
var path = require('path');

var makeStatsD = require('./statsd');
var BaseService = require('./base_service');
var HeapWatch = require('./heapwatch');
var RateLimiterWorker = require('./ratelimiter').worker;
var RateLimiterNoCluster = require('./ratelimiter').nocluster;

/**
 * Worker class, inherits from BaseService.
 * Contains logic that runs on a worker process.
 *
 * (Note: if num_workers is zero, no forks are created,
 *  so this code runs on master process)
 *
 * @constructor
 */
function Worker(options) {
    BaseService.call(this, options);
}

util.inherits(Worker, BaseService);

Worker.prototype._getConfigUpdateAction = function() {
    var self = this;
    return new P(function(resolve, reject) {
        var timeout = setTimeout(function() {
            reject(new Error('Timeout waiting for config in worker ' + process.pid));
        }, 3000);
        process.on('message', function(message) {
            if (message.type === 'config') {
                clearTimeout(timeout);
                self._updateConfig(message.body)
                .then(resolve);
            } else if (message.type === 'ratelimiter_blocks') {
                if (self._ratelimiter) {
                    self._ratelimiter._updateBlocks(message.value);
                }
            } else {
                reject(new Error('Invalid message received: ' + JSON.stringify(message)));
            }
        });

        if (cluster.isWorker) {
            // If got a status update in a worker - forward it to the master
            process.on('service_status', function(message) {
                try {
                    process.send({
                        type: 'service_status',
                        status: message
                    });
                } catch (e) {
                    self._logger.log('warn/service-runner/worker/', {
                        msg: 'Error sending worker status update',
                        err: e
                    });
                }
            });
        }
    });
};

Worker.prototype.stop = function() {
    var self = this;
    if (self.interval) {
        clearInterval(self.interval);
    }
    if (Array.isArray(self.serviceReturns)) {
        return P.each(self.serviceReturns, function(serviceRet) {
            if (serviceRet && typeof serviceRet.close === 'function') {
                return serviceRet.close();
            }
        });
    } else {
        return P.resolve();
    }
};

Worker.prototype._start = function() {
    var self = this;
    // Worker.
    process.on('SIGTERM', function() {
        return self.stop()
        .then(function() {
            self._logger.log('info/service-runner/worker', 'Worker '
                    + process.pid + ' shutting down');
            process.exit(0);
        });
    });

    // Enable heap dumps in /tmp on kill -USR2.
    // See https://github.com/bnoordhuis/node-heapdump/
    // For node 0.6/0.8: npm install heapdump@0.1.0
    // For 0.10: npm install heapdump
    process.on('SIGUSR2', function() {
        try {
            var heapdump = require('heapdump');
            var cwd = process.cwd();
            console.error('SIGUSR2 received! Writing snapshot.');
            process.chdir('/tmp');
            heapdump.writeSnapshot();
            process.chdir(cwd);
        } catch (e) {
            self._logger.log('warn/service-runner/worker',
                'Worker ' + process.pid + ' received SIGUSR2, but heapdump is not installed');
        }

        // Also switch on trace logging for 5 seconds
        console.error('Switching on trace logging for 5 seconds.');
        self._logger.constructor.logTrace = true;
        setTimeout(function() {
            console.error('Switching trace logging off.');
            self._logger.constructor.logTrace = false;
        }, 5000);
    });

    // Metrics reporter
    self._metrics = makeStatsD(self.config.metrics, self._logger);

    // Heap limiting
    // We try to restart workers before they get slow
    // Default to something close to the default node 2g limit
    var limitMB = parseInt(self.config.worker_heap_limit_mb) || 1500;
    new HeapWatch({ limitMB: limitMB }, this._logger, this._metrics).watch();

    if (cluster.isWorker) {
        self._workerHeartBeat();
    }

    // Rate limiting.
    if (cluster.isWorker) {
        self._ratelimiter = new RateLimiterWorker(self.config.ratelimiter);
    } else {
        self._ratelimiter = new RateLimiterNoCluster(self.config.ratelimiter);
        self._ratelimiter.setup();
    }

    // Require service modules and start them
    return P.map(this.config.services, function(service) {
        var name = service.name || service.module;
        var basePath = service.app_base_path ?
            path.resolve(self._basePath, service.app_base_path) :
            self._basePath;
        service.conf.worker_id = self.config.worker_id;
        var opts = {
            name: name,
            appBasePath: basePath,
            config: service.conf,
            logger: self._logger.child({
                name: name,
            }),
            // todo: set up custom prefix
            metrics: self._metrics,
            ratelimiter: self._ratelimiter
        };

        return self._requireModule(service.module || service.name)
        .then(function(svcMod) {
            if (service.entrypoint) {
                return svcMod[service.entrypoint](opts);
            } else {
                return svcMod(opts);
            }
        });
    })
    .then(function(res) {
        var ret;
        self.serviceReturns = res;
        // Make sure that only JSON-serializable values are returned.
        try {
            ret = JSON.parse(JSON.stringify(res));
        } catch (e) {
            ret = [e];
        }
        // Signal that this worker finished startup
        if (cluster.isWorker) {
            process.send({ type: 'startup_finished', serviceReturns: ret });
        }
        return ret;
    })
    .catch(function(e) {
        self._logger.log('fatal/service-runner/worker', e);
        // Give the logger some time to do its work before exiting
        // synchronously.
        // XXX: Consider returning a Promise from logger.log.
        return P.delay(1000)
        .then(function() {
            process.exit(1);
        });
    });
};

Worker.prototype._workerHeartBeat = function() {
    // We send heart beat 3 times more frequently than check it
    // to avoid possibility of wrong restarts
    process.send({ type: 'heartbeat' });
    this.interval = setInterval(function() {
        process.send({ type: 'heartbeat' });
    }, this.config.worker_heartbeat_timeout / 3);
};

module.exports = Worker;
