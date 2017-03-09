'use strict';

const cluster = require('cluster');

class HeapWatch {
    constructor(conf, logger, statsd) {
        this.conf = conf =  conf || {};
        this.limit = (conf.limitMB || 1500) * 1024 * 1024;
        this.logger = logger;
        this.statsd = statsd;
        this.checkInterval = 60000; // Once per minute
        this.failCount = 0;
    }

    watch() {
        const usage = process.memoryUsage();

        // Report memory stats to statsd. Use 'timing' (which isn't really
        // timing-specific at all) instead of 'gauge' to get percentiles &
        // min/max.
        const statsd = this.statsd;
        statsd.timing('heap.rss', usage.rss);
        statsd.timing('heap.total', usage.heapTotal);
        statsd.timing('heap.used', usage.heapUsed);

        if (usage.heapUsed > this.limit) {
            this.failCount++;
            if (this.failCount > 3) {
                this.logger.log('fatal/service-runner/heap', {
                    message: 'Heap memory limit exceeded',
                    limit: this.limit,
                    memoryUsage: usage
                });
                // Don't try to restart a worker when num_workers = 0, just log a problem
                if (cluster.isWorker) {
                    // Delay the restart long enough to allow the log to be sent out
                    setTimeout(() => {
                        cluster.worker.disconnect();
                    }, 1000);
                    // And forcefully exit 60 seconds later
                    setTimeout(() => {
                        process.exit(1);
                    }, 60000);
                    return;
                }
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
    }
}

module.exports = HeapWatch;
