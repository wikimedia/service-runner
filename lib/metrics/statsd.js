'use strict';

const StatsD = require('hot-shots');
const normalizeName = require('./utils').normalizeName;
const formatLabels = require('./utils').formatLabels;

/**
 * Maximum size of a metrics batch used by default.
 *
 * @const
 * @type {number}
 */
const DEFAULT_MAX_BATCH_SIZE = 1450;

// StatsD Metrics implementation
class StatsDMetric {
    constructor(options, client) {
        this.options = options;
        if (options.labels === undefined) {
            options.labels = { names: [] };
        }
        this.client = client;
    }

    _call(func, value, labels) {
        labels = formatLabels(this.options, labels);
        func.apply(this.client, [normalizeName(labels.join('.')), value, this.options.sampleRate]);
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

class StatsDClient {
    constructor(options, logger) {
        this.logger = logger;
        const srvName = options._prefix ? options._prefix : normalizeName(options.name);
        const statsdOptions = {
            host: options.host,
            port: options.port,
            prefix: `${srvName}.`,
            suffix: '',
            globalize: false,
            cacheDns: false,
            mock: false
        };

        // Batch metrics unless `batch` option is `false`
        if (typeof options.batch !== 'boolean' || options.batch) {
            options.batch = options.batch || {};
            statsdOptions.maxBufferSize = options.batch.max_size || DEFAULT_MAX_BATCH_SIZE;
            statsdOptions.bufferFlushInterval = options.batch.max_delay || 1000;
        }
        this.client = new StatsD(statsdOptions);
        this.client.normalizeName = normalizeName;
    }

    childClient() {
        return this.client.childClient();
    }

    makeMetric(options) {
        return new StatsDMetric(options, this.client);
    }

    close() {
        this.client.close();
    }
}

const timingMixin = {
    endTiming(names, startTime, samplingInterval) {
        return this.timing(names, Date.now() - startTime, samplingInterval);
    }
};

// apply timingMixin
Object.assign(StatsD.prototype, timingMixin);

module.exports = StatsDClient;
