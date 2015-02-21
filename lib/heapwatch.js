"use strict";

var cluster = require('cluster');

function HeapWatch (conf, logger, statsd) {
    this.conf = conf =  conf || {};
    this.limit = (conf.limitMB || 1500) * 1024 * 1024;
    this.logger = logger;
    this.statsd = statsd;
    this.checkInterval = 60000; // once per minute
    this.failCount = 0;
}

HeapWatch.prototype.watch = function() {
    var usage = process.memoryUsage();

    // Report memory stats to statsd
    var statsd = this.statsd;
    statsd.gauge('heap.rss', usage.rss);
    statsd.gauge('heap.total', usage.heapTotal);
    statsd.gauge('heap.used', usage.heapUsed);

    if (usage.heapUsed > this.limit) {
        console.log(usage.heapUsed, this.limit);
        this.failCount++;
        if (this.failCount > 5) {
            this.logger.log('fatal/service-runner/heap', {
                message: 'Heap memory limit exceeded',
                limit: this.limit,
                memoryUsage: usage
            });
            // Delay the restart long enough to allow the log to be sent out
            setTimeout(function() {
                cluster.worker.disconnect();
            }, 1000);
            return;
        } else {
            this.logger.log('warn/service-runner/heap', {
                message: 'Heap memory limit temporarily exceeded',
                limit: this.limit,
                memoryUsage: usage
            });
        }

    } else {
        this.failCount = 0;
    }
    setTimeout(this.watch.bind(this), this.checkInterval);
};

module.exports = HeapWatch;
