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
                    this.staticLabels[name] = this._normalize(this.staticLabels[name]);
                });
            }
        }
        options.prometheus.name = this._normalize(options.prometheus.name);
        options.prometheus.labelNames = options.prometheus.labelNames || [];
        options.prometheus.labelNames = options.prometheus.labelNames.map(this._normalize);
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
                if (labels.indexOf(this.staticLabels[name]) === -1) {
                    labels.unshift(this.staticLabels[name]);
                }
            });
        }
    }

    _normalize(str) {
        return String(str).replace( /\W/g, '_' ) // replace non-alphanumerics
            .replace( /_+/g, '_' ) // dedupe underscores
            .replace( /(^_+|_+$)/g, '' ); // trim leading and trailing underscores
    }

    increment(amount, labels) {
        this._handleStaticLabels(labels);
        labels = labels.map(this._normalize);
        this.metric.labels.apply(this.metric, labels).inc(amount);
    }

    decrement(amount, labels) {
        this._handleStaticLabels(labels);
        labels = labels.map(this._normalize);
        this.metric.labels.apply(this.metric, labels).dec(amount);
    }

    observe(value, labels) {
        this._handleStaticLabels(labels);
        labels = labels.map(this._normalize);
        this.metric.labels.apply(this.metric, labels).observe(value);
    }

    gauge(amount, labels) {
        this._handleStaticLabels(labels);
        labels = labels.map(this._normalize);
        if (amount < 0) {
            this.metric.labels.apply(this.metric, labels).dec(Math.abs(amount));
        } else {
            this.metric.labels.apply(this.metric, labels).inc(amount);
        }
    }

    set(value, labels) {
        this._handleStaticLabels(labels);
        labels = labels.map(this._normalize);
        this.metric.labels.apply(this.metric, labels).set(value);
    }

    timing(value, labels) {
        this._handleStaticLabels(labels);
        labels = labels.map(this._normalize);
        this.observe(value, labels);
    }

    endTiming(startTime, labels) {
        this._handleStaticLabels(labels);
        labels = labels.map(this._normalize);
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
