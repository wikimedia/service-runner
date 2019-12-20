'use strict';

const Prometheus = require('prom-client');

// Prometheus metrics implementation
class PrometheusMetric {
    constructor(options, client) {
        this.client = client;
        if (options.labels === undefined) {
            options.labels = { names: [] };
        }
        this.staticLabels = options.prometheus.staticLabels;
        if (this.staticLabels !== undefined) {
            if (Object.keys(this.staticLabels).length > 0) {
                Object.keys(this.staticLabels).forEach((name) => {
                    options.labels.names.unshift(name);
                });
            }
        }
        this.metric = new this.client[options.type]({
            name: options.prometheus.name,
            help: options.prometheus.help,
            labelNames: options.labels.names,
            buckets: options.prometheus.buckets,
            percentiles: options.prometheus.percentiles
        });
    }

    _handleStaticLabels(labels) {
        if (this.staticLabels !== undefined) {
            Object.keys(this.staticLabels).forEach((name) => {
                labels.unshift(this.staticLabels[name]);
            });
        }
    }

    increment(amount, labels) {
        this._handleStaticLabels(labels);
        this.metric.labels.apply(this.metric, labels).inc(amount);
    }

    decrement(amount, labels) {
        this._handleStaticLabels(labels);
        this.metric.labels.apply(this.metric, labels).dec(amount);
    }

    observe(value, labels) {
        this._handleStaticLabels(labels);
        this.metric.labels.apply(this.metric, labels).observe(value);
    }

    gauge(amount, labels) {
        this._handleStaticLabels(labels);
        if (amount < 0) {
            this.metric.labels.apply(this.metric, labels).dec(Math.abs(amount));
        } else {
            this.metric.labels.apply(this.metric, labels).inc(amount);
        }
    }

    set(value, labels) {
        this._handleStaticLabels(labels);
        this.metric.labels.apply(this.metric, labels).set(value);
    }

    timing(value, labels) {
        this.set(value, labels);
    }

    endTiming(startTime, labels) {
        this.timing(Date.now() - startTime, labels);
    }
}

class PrometheusClient {
    constructor(options, logger) {
        this.options = options;
        this.logger = logger;
        this.client = Prometheus;
    }

    makeMetric(options) {
        return new PrometheusMetric(options, this.client);
    }

    close() {}
}

module.exports = PrometheusClient;
