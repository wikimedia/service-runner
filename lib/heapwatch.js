'use strict';

const cluster = require('cluster');

class HeapWatch {
    constructor(conf, logger, metrics) {
        this.conf = conf = conf || {};
        this.limit = (conf.limitMB || 1500) * 1024 * 1024;
        this.logger = logger;
        this.metrics = metrics;
        this.checkInterval = 60000; // Once per minute
        this.failCount = 0;
        this.timeoutHandle = undefined;
    }

    watch() {
        const usage = process.memoryUsage();
        this.metrics.makeMetric({
            type: 'Gauge',
            name: 'heap.rss',
            prometheus: {
                name: 'nodejs_process_heap_rss_bytes',
                help: 'process heap usage',
                staticLabels: this.metrics.getServiceLabel()
            }
        }).set(usage.rss);
        this.metrics.makeMetric({
            type: 'Gauge',
            name: 'heap.used',
            prometheus: {
                name: 'nodejs_process_heap_used_bytes',
                help: 'process heap usage',
                staticLabels: this.metrics.getServiceLabel()
            }
        }).set(usage.heapUsed);
        this.metrics.makeMetric({
            type: 'Gauge',
            name: 'heap.total',
            prometheus: {
                name: 'nodejs_process_heap_total_bytes',
                help: 'process heap usage',
                staticLabels: this.metrics.getServiceLabel()
            }
        }).set(usage.heapTotal);
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
        this.timeoutHandle = setTimeout(this.watch.bind(this), this.checkInterval);
    }

    close() {
        if (this.timeoutHandle) {
            clearTimeout(this.timeoutHandle);
            this.timeoutHandle = undefined;
        }
    }
}

module.exports = HeapWatch;
