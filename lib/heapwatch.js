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

HeapWatch.prototype.watch = function(doChecklimit) {
    doChecklimit = doChecklimit === false ? false : true;
    var usage = process.memoryUsage();

    // Report memory stats to statsd. Use 'timing' (which isn't really
    // timing-specific at all) instead of 'gauge' to get percentiles &
    // min/max.
    var statsd = this.statsd;
    statsd.timing('heap.rss', usage.rss);
    statsd.timing('heap.total', usage.heapTotal);
    statsd.timing('heap.used', usage.heapUsed);

    if (!doChecklimit) {
        // just report, reset the time-out and return
        // no checks need to be performed
        setTimeout(this.watch.bind(this), this.checkInterval, false);
        return;
    }

    if (usage.heapUsed > this.limit) {
        this.failCount++;
        if (this.failCount > 3) {
            this.logger.log('fatal/service-runner/heap', {
                message: 'Heap memory limit exceeded',
                limit: this.limit,
                memoryUsage: usage
            });
            // Delay the restart long enough to allow the log to be sent out
            setTimeout(function() {
                cluster.worker.disconnect();
            }, 1000);
            // And forcefully exit 60 seconds later
            setTimeout(function() {
                process.exit(1);
            }, 60000);
            doChecklimit = false;
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
    setTimeout(this.watch.bind(this), this.checkInterval, doChecklimit);
};

module.exports = HeapWatch;
