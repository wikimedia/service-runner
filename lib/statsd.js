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
        serviceName = serviceName ? `${serviceName}.` : 'service-runner.';
        methods.forEach((method) => {
            this[method] = (name, value, samplingInterval) => {
                name = serviceName + name;
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
}

const timingMixin = {
    endTiming(names, startTime, samplingInterval) {
        return this.timing(names, Date.now() - startTime, samplingInterval);
    }
};

// Also add a small utility to send a delta given a startTime
Object.assign(StatsD.prototype, timingMixin);

// Minimal StatsD wrapper
function makeStatsD(options, logger) {
    let statsd;
    const srvName = options._prefix ? options._prefix : normalizeName(options.name);
    const statsdOptions = {
        host: options.host,
        port: options.port,
        prefix:  `${srvName}.`,
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
        const childOptions = Object.assign({}, options);
        childOptions.prefix = statsdOptions.prefix + normalizeName(name);

        const child = statsd.childClient(childOptions);

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
