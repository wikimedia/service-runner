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
        this.staticLabels = this.options.prometheus.staticLabels || {};

        // Add staticLabel names to list of known label names.
        Object.keys(this.staticLabels).forEach((labelName) => {
            this.options.labels.names.unshift(labelName);
        });
        // Normalize all the label names.
        this.options.labels.names = this.options.labels.names.map(this._normalize)

        this.options.prometheus.name = this._normalize(this.options.prometheus.name);
        this.metric = new this.client[this.options.type]({
            name: this.options.prometheus.name,
            help: this.options.prometheus.help,
            labelNames: this.options.labels.names,
            buckets: this.options.prometheus.buckets,
            percentiles: this.options.prometheus.percentiles
        });
    }

    /**
     * Normalizes a prometheus string. Should be used for label
     * and metric names, but is not needed for label values.
     *
     * @param {string} str
     * @return {string}
     */
    _normalize(str) {
        return String(str).replace( /\W/g, '_' ) // replace non-alphanumerics
            .replace( /_+/g, '_' ) // dedupe underscores
            .replace( /(^_+|_+$)/g, '' ); // trim leading and trailing underscores
    }

    /**
     * Gets label values array for this metric
     * including both static and dynamic labels merged together.
     *
     * @param {Array} labelValues
     * @return {Array}
     */
     _getLabelValues(labelValues) {
        // make a clone of labelValues.
        const updatedLabelValues = [...labelValues];
        // Add staticLabel values to updatedLabelValues if they aren't already listed.
        Object.keys(this.staticLabels).forEach((labelName) => {
            if (updatedLabelValues.indexOf(this.staticLabels[labelName]) === -1) {
                updatedLabelValues.unshift(this.staticLabels[labelName]);
            }
        });
        return updatedLabelValues;
    }

    increment(amount, labelValues) {
        const updatedLabelValues = this._getLabelValues(labelValues);
        this.metric.labels.apply(this.metric, updatedLabelValues).inc(amount);
    }

    decrement(amount, labelValues) {
        const updatedLabelValues = this._getLabelValues(labelValues);
        this.metric.labels.apply(this.metric, updatedLabelValues).dec(amount);
    }

    observe(value, labelValues) {
        const updatedLabelValues = this._getLabelValues(labelValues);
        this.metric.labels.apply(this.metric, updatedLabelValues).observe(value);
    }

    gauge(amount, labelValues) {
        const updatedLabelValues = this._getLabelValues(labelValues);
        if (amount < 0) {
            this.metric.labels.apply(this.metric, updatedLabelValues).dec(Math.abs(amount));
        } else {
            this.metric.labels.apply(this.metric, updatedLabelValues).inc(amount);
        }
    }

    set(value, labelValues) {
        const updatedLabelValues = this._getLabelValues(labelValues);
        this.metric.labels.apply(this.metric, updatedLabelValues).set(value);
    }

    timing(value, labelValues) {
        const updatedLabelValues = this._getLabelValues(labelValues);
        this.observe(value, updatedLabelValues);
    }

    endTiming(startTime, labelValues) {
        const updatedLabelValues = this._getLabelValues(labelValues);
        this.timing(Date.now() - startTime, updatedLabelValues);
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
