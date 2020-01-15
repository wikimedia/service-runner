'use strict';

const normalizeName = require('./utils').normalizeName;
const formatLabels = require('./utils').formatLabels;

// Metric logger implementation
class LogMetric {
    constructor(options, client) {
        this.options = options;
        if (options.labels === undefined) {
            options.labels = { names: [] };
        }
        this.client = client;
    }

    _call(func, value, labels) {
        labels = formatLabels(this.options, labels);
        func.apply(this.client, [normalizeName(labels.join('.')), value]);
    }

    increment(amount, labels) {
        this._call(this.client.increment, amount, labels);
    }

    decrement(amount, labels) {
        this._call(this.client.decrement, amount, labels);
    }

    observe(value, labels) {
        this._call(this.client.gauge, value, labels);
    }

    gauge(amount, labels) {
        this._call(this.client.gauge, amount, labels);
    }

    set(value, labels) {
        this._call(this.client.gauge, value, labels);
    }

    timing(value, labels) {
        this._call(this.client.timing, value, labels);
    }

    endTiming(startTime, labels) {
        this.timing(Date.now() - startTime, labels);
    }
}

// A simple console reporter. Useful for development.
class LogClient {
    constructor(options, logger) {
        this._logger = logger;
        this._serviceName = options.name ? `${options.name}.` : 'service-runner.';
        this.methods = options.methods;
        // For compatibility with hot-shots this will be set externally by makeChild
        this.prefix = this._serviceName;
        this.methods.forEach((method) => {
            this[method] = (name, value, samplingInterval) => {
                name = this.prefix + name;
                logger.log('trace/metrics', {
                    message: [method, name, value].join(':'),
                    method,
                    name,
                    value,
                    samplingInterval
                });
            };
        });

        this.client = this;
    }

    childClient() {
        return new LogClient({ name: this._serviceName, methods: this.methods }, this._logger);
    }

    makeMetric(options) {
        return new LogMetric(options, this.client);
    }

    close() {}
}

module.exports = LogClient;
