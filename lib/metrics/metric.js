'use strict';

// types correlate to Prometheus metric types.
const types = {
    GAUGE: 'Gauge',
    HISTOGRAM: 'Histogram',
    COUNTER: 'Counter',
    SUMMARY: 'Summary',
    TIMING: 'Histogram'
};

// Metric interface
class Metric {
    constructor(clients, logger, options) {
        this.type = options.type;
        this.logger = logger;
        this.metrics = clients.map((client) => client.makeMetric(options));
    }

    increment(amount, labels) {
        labels = labels || [];
        amount = amount || 1;
        if ([types.COUNTER, types.GAUGE].indexOf(this.type) !== -1) {
            this.metrics.map((metric) => metric.increment(amount, labels));
        } else {
            this.logger.log('error/metrics', `increment() unsupported for metric type ${this.type}`);
        }
    }

    decrement(amount, labels) {
        labels = labels || [];
        amount = amount || 1;
        if (this.type === types.GAUGE) {
            this.metrics.map((metric) => metric.decrement(amount, labels));
        } else {
            this.logger.log('error/metrics', `decrement() unsupported for metric type ${this.type}`);
        }
    }

    observe(value, labels) {
        labels = labels || [];
        if ([types.HISTOGRAM, types.SUMMARY].indexOf(this.type) !== -1) {
            this.metrics.map((metric) => metric.observe(value, labels));
        } else {
            this.logger.log('error/metrics', `observe() unsupported for metric type ${this.type}`);
        }
    }

    gauge(amount, labels) {
        labels = labels || [];
        if (this.type === types.GAUGE) {
            this.metrics.map((metric) => metric.gauge(amount, labels));
        } else {
            this.logger.log('error/metrics', `set() or unique() unsupported for metric type ${this.type}`);
        }
    }

    set(value, labels) {
        labels = labels || [];
        if (this.type === types.GAUGE) {
            this.metrics.map((metric) => metric.set(value, labels));
        } else {
            this.logger.log('error/metrics', `set() or unique() unsupported for metric type ${this.type}`);
        }
    }

    timing(value, labels) {
        labels = labels || [];
        if (this.type === types.TIMING) {
            this.metrics.map((metric) => metric.timing(value, labels));
        } else {
            this.logger.log('error/metrics', `timing() unsupported for metric type ${this.type}`);
        }
    }

    endTiming(startTime, labels) {
        labels = labels || [];
        if (this.type === types.TIMING) {
            this.metrics.map((metric) => metric.endTiming(startTime, labels));
        } else {
            this.logger.log('error/metrics', `endTiming() unsupported for metric type ${this.type}`);
        }
    }
}

module.exports = Metric;
