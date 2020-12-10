'use strict';

const Prometheus = require('prom-client');
const cloneDeep = require('lodash.clonedeep');

// Prometheus metrics implementation
class PrometheusMetric {
    constructor(options, client) {
        this.client = client;
        this.options = cloneDeep(options);
        if (this.options.labels === undefined) {
            this.options.labels = { names: [] };
        }
        this.staticLabels = this.options.prometheus.staticLabels;
        if (this.staticLabels !== undefined) {
            if (Object.keys(this.staticLabels).length > 0) {
                Object.keys(this.staticLabels).forEach((name) => {
                    this.options.labels.names.unshift(name);
                    this.staticLabels[name] = this._normalize(this.staticLabels[name]);
                });
            }
        }
        this.options.prometheus.name = this._normalize(this.options.prometheus.name);
        this.options.prometheus.labelNames = this.options.prometheus.labelNames || [];
        this.options.prometheus.labelNames = this.options.prometheus.labelNames
            .map(this._normalize);
        this.metric = new this.client[this.options.type]({
            name: this.options.prometheus.name,
            help: this.options.prometheus.help,
            labelNames: this.options.labels.names,
            buckets: this.options.prometheus.buckets,
            percentiles: this.options.prometheus.percentiles
        });
    }

    _handleStaticLabels(labels) {
        const updatedLabels = [...labels];
        if (this.staticLabels !== undefined) {
            Object.keys(this.staticLabels).forEach((name) => {
                if (updatedLabels.indexOf(this.staticLabels[name]) === -1) {
                    updatedLabels.unshift(this.staticLabels[name]);
                }
            });
        }
        return updatedLabels;
    }

    _normalize(str) {
        return String(str).replace( /\W/g, '_' ) // replace non-alphanumerics
            .replace( /_+/g, '_' ) // dedupe underscores
            .replace( /(^_+|_+$)/g, '' ); // trim leading and trailing underscores
    }

    increment(amount, labels) {
        const updatedLabels = this._handleStaticLabels(labels).map(this._normalize);
        this.metric.labels.apply(this.metric, updatedLabels).inc(amount);
    }

    decrement(amount, labels) {
        const updatedLabels = this._handleStaticLabels(labels).map(this._normalize);
        this.metric.labels.apply(this.metric, updatedLabels).dec(amount);
    }

    observe(value, labels) {
        const updatedLabels = this._handleStaticLabels(labels).map(this._normalize);
        this.metric.labels.apply(this.metric, updatedLabels).observe(value);
    }

    gauge(amount, labels) {
        const updatedLabels = this._handleStaticLabels(labels).map(this._normalize);
        if (amount < 0) {
            this.metric.labels.apply(this.metric, updatedLabels).dec(Math.abs(amount));
        } else {
            this.metric.labels.apply(this.metric, updatedLabels).inc(amount);
        }
    }

    set(value, labels) {
        const updatedLabels = this._handleStaticLabels(labels).map(this._normalize);
        this.metric.labels.apply(this.metric, updatedLabels).set(value);
    }

    timing(value, labels) {
        const updatedLabels = this._handleStaticLabels(labels).map(this._normalize);
        this.observe(value, updatedLabels);
    }

    endTiming(startTime, labels) {
        const updatedLabels = this._handleStaticLabels(labels).map(this._normalize);
        this.timing(Date.now() - startTime, updatedLabels);
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
