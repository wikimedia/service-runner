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
    constructor(conf, logger, statsd, prometheus) {
        this.conf = conf = conf || {};
        this.limit = (conf.limitMB || 1500) * 1024 * 1024;
        this.logger = logger;
        this.statsd = statsd;
        this.prometheus = prometheus;
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
        if (this.prometheus) {
            this.heap_rss = new this.prometheus.Gauge({
                name: 'service_runner_heapwatch_rss_bytes',
                help: 'heapwatch rss bytes'
            });
            this.heap_total = new this.prometheus.Gauge({
                name: 'service_runner_heapwatch_total_bytes',
                help: 'heapwatch total bytes'
            });
            this.heap_used = new this.prometheus.Gauge({
                name: 'service_runner_heapwatch_used_bytes',
                help: 'heapwatch used bytes'
            });
            this.gc_minor = new this.prometheus.Counter({
                name: 'service_runner_heapwatch_gc_minor_ns',
                help: 'minor gc pause ns'
            });
            this.gc_major = new this.prometheus.Counter({
                name: 'service_runner_heapwatch_gc_major_ns',
                help: 'major gc pause ns'
            });
            this.gc_incremental = new this.prometheus.Counter({
                name: 'service_runner_heapwatch_gc_incremental_ns',
                help: 'incremental gc pause ns'
            });
            this.gc_weak = new this.prometheus.Counter({
                name: 'service_runner_heapwatch_gc_weak_ns',
                help: 'weak gc pause ns'
            });
        }
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
                if (this.prometheus) {
                    this.gc_major.inc(this.cumulativeGCTimes.major);
                    this.gc_minor.inc(this.cumulativeGCTimes.minor);
                    this.gc_incremental.inc(this.cumulativeGCTimes.incremental);
                    this.gc_weak.inc(this.cumulativeGCTimes.weak);
                }
                if (this.statsd) {
                    const timings = {};
                    Object.keys(this.cumulativeGCTimes).forEach((gcType) => {
                        const totalGCTime = this.cumulativeGCTimes[gcType];
                        if (totalGCTime > 0) {
                            timings[`gc.${gcType}`] = totalGCTime;
                        }
                    });
                    this.cumulativeGCTimes = Object.assign({}, ZERO_CUMULATIVE_GC_INTERVAL);
                    Object.keys(timings).forEach((stat) => {
                        this.statsd.timing(stat, timings[stat]);
                    });
                }
            }, GC_REPORT_INTERVAL);
        } catch (e) {
            // gc-stats is a binary dependency, so if it's not installed
            // ignore reporting GC metrics
        }
    }

    watch() {
        const usage = process.memoryUsage();
        if (this.prometheus) {
            this.heap_rss.set(usage.rss);
            this.heap_total.set(usage.heapTotal);
            this.heap_used.set(usage.heapUsed);
        }
        if (this.statsd) {
            // Report memory stats to statsd. Use 'timing' (which isn't really
            // timing-specific at all) instead of 'gauge' to get percentiles &
            // min/max.
            this.statsd.timing('heap.rss', usage.rss);
            this.statsd.timing('heap.total', usage.heapTotal);
            this.statsd.timing('heap.used', usage.heapUsed);
        }
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
