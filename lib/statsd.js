'use strict';

const StatsD = require('hot-shots');

/**
 * Maximum size of a metrics batch used by default.
 *
 * @const
 * @type {number}
 */
const DEFAULT_MAX_BATCH_SIZE = 1450;

const nameCache = new Map();

function normalizeName(name) {
    // See https://github.com/etsy/statsd/issues/110
    // Only [\w_.-] allowed, with '.' being the hierarchy separator.
    let res = nameCache.get(name);
    if (res) {
        return res;
    } else {
        res = name.replace(/[^/a-zA-Z0-9.-]/g, '-').replace(/\//g, '_');
        nameCache.set(name, res);
        return res;
    }
}

// A simple console reporter. Useful for development.
const methods = ['timing', 'increment', 'decrement', 'gauge', 'unique'];
class LogStatsD {
    constructor(logger, serviceName) {
        this._logger = logger;
        this._serviceName = serviceName ? `${serviceName}.` : 'service-runner.';
        // For compatibility with hot-shots this will be set externally by makeChild
        this.prefix = this._serviceName;
        methods.forEach((method) => {
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
    }
    childClient() {
        return new LogStatsD(
            this._logger,
            this._serviceName
        );
    }
}

const timingMixin = {
    endTiming(names, startTime, samplingInterval) {
        return this.timing(names, Date.now() - startTime, samplingInterval);
    }
};

// Also add a small utility to send a delta given a startTime
Object.assign(StatsD.prototype, timingMixin);
Object.assign(LogStatsD.prototype, timingMixin);

// Minimal StatsD wrapper
function makeStatsD(options, logger) {
    let statsd;
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

    if (options.type === 'log') {
        statsd = new LogStatsD(logger, srvName);
    } else {
        statsd = new StatsD(statsdOptions);
    }

    // Support creating sub-metric clients with a fixed prefix. This is useful
    // for systematically categorizing metrics per-request, by using a
    // specific logger.
    statsd.makeChild = (name) => {
        const child = statsd.childClient();
        // We can't use the prefix in clientOptions,
        // because it will be prepended to existing prefix.
        child.prefix = statsd.prefix + normalizeName(name) + '.';

        // Attach normalizeName to make the childClient instance backwards-compatible
        // with the previously used StatsD instance
        child.normalizeName = normalizeName;

        return child;
    };

    // Add a static utility method for stat name normalization
    statsd.normalizeName = normalizeName;

    return statsd;
}

module.exports = makeStatsD;
