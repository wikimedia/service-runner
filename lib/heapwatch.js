'use strict';

const cluster = require('cluster');

const ZERO_CUMULATIVE_GC_INTERVAL = {
    minor: 0,
    major: 0,
    incremental: 0,
    weak: 0
};
const GC_REPORT_INTERVAL = 1000;

class HeapWatch {
    constructor(conf, logger, metrics) {
        this.conf = conf = conf || {};
        this.limit = (conf.limitMB || 1500) * 1024 * 1024;
        this.logger = logger;
        this.metrics = metrics;
        this.checkInterval = 60000; // Once per minute
        this.failCount = 0;
        this.timeoutHandle = undefined;
        this.gcReportInterval = undefined;
        this.cumulativeGCTimes = Object.assign({}, ZERO_CUMULATIVE_GC_INTERVAL);
        this.reportStatsHandler = (stats) => {
                // Report GC timings to statsd (in nanoseconds).
                const type = this._gcTypeName(stats.gctype);
                if (type !== 'unknown') {
                    this.cumulativeGCTimes[this._gcTypeName(stats.gctype)] += stats.pause;
                }
        };
        this._gcStats = null;
    }

    _gcTypeName(typeID) {
        switch (typeID) {
            case 1: return 'minor';
            case 2: return 'major';
            case 4: return 'incremental';
            case 8: return 'weak';
            case 15: return 'all';
            default: return 'unknown';
        }
    }

    setGCMonitor() {
        try {
            this._gcStats = require('gc-stats')();
            this._gcStats.on('stats', this.reportStatsHandler);
            this.gcReportInterval = setInterval(() => {
                const gcMetrics = this.metrics.makeMetric({
                    type: 'Gauge',
                    name: 'gc',
                    prometheus: {
                        name: 'service_runner_heapwatch_gc_ns',
                        help: 'heapwatch gc pause ns'
                    },
                    labels: {
                        names: ['type'],
                        omitLabelNames: true
                    }
                });
                Object.keys(this.cumulativeGCTimes).forEach((gcType) => {
                    const totalGCTime = this.cumulativeGCTimes[gcType];
                    if (totalGCTime > 0) {
                        gcMetrics.timing(totalGCTime, [gcType]);
                    }
                });
                this.cumulativeGCTimes = Object.assign({}, ZERO_CUMULATIVE_GC_INTERVAL);
            }, GC_REPORT_INTERVAL);
        } catch (e) {
            // gc-stats is a binary dependency, so if it's not installed
            // ignore reporting GC metrics
        }
    }

    watch() {
        const usage = process.memoryUsage();
        const heapMetrics = this.metrics.makeMetric({
            type: 'Gauge',
            name: 'heap',
            prometheus: {
                name: 'service_runner_heap_bytes',
                help: 'service runner heapwatch heap usage'
            },
            labels: {
                names: ['type'],
                omitLabelNames: true
            }
        });
        heapMetrics.set(usage.rss, ['rss']);
        heapMetrics.set(usage.heapTotal, ['total']);
        heapMetrics.set(usage.heapUsed, ['used']);
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
        if (this._gcStats) {
            this._gcStats.removeListener('stats', this.reportStatsHandler);
        }
        if (this.timeoutHandle) {
            clearTimeout(this.timeoutHandle);
            this.timeoutHandle = undefined;
        }
        if (this.gcReportInterval) {
            clearInterval(this.gcReportInterval);
            this.gcReportInterval = undefined;
        }
    }
}

module.exports = HeapWatch;
