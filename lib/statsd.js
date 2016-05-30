'use strict';
var StatsD = require('hot-shots');

/**
 * Maximum size of a metrics batch used by default.
 *
 * @const
 * @type {number}
 */
var DEFAULT_MAX_BATCH_SIZE = 1450;

function objectAssign(target, source) {
    Object.keys(source).forEach(function(keyName) {
        target[keyName] = source[keyName];
    });
    return target;
}

var nameCache = {};
function normalizeName(name) {
    // See https://github.com/etsy/statsd/issues/110
    // Only [\w_.-] allowed, with '.' being the hierarchy separator.
    var res = nameCache[name];
    if (res) {
        return res;
    } else {
        nameCache[name] = name.replace(/[^\/a-zA-Z0-9\.\-]/g, '-')
            .replace(/\//g, '_');
        return nameCache[name];
    }
}

// A simple console reporter. Useful for development.
var methods = ['timing', 'increment', 'decrement', 'gauge', 'unique'];
function LogStatsD(logger, serviceName) {
    var self = this;
    serviceName = serviceName ? serviceName + '.' : 'service-runner.';
    methods.forEach(function(method) {
        self[method] = function(name, value, samplingInterval) {
            name = serviceName + name;
            logger.log('trace/metrics', {
                message: [method, name, value].join(':'),
                method: method,
                name: name,
                value: value,
                samplingInterval: samplingInterval
            });
        };
    });
}

// Minimal StatsD wrapper
function makeStatsD(options, logger) {
    var statsd;
    var srvName = options._prefix ? options._prefix : normalizeName(options.name);
    var statsdOptions = {
        host: options.host,
        port: options.port,
        prefix:  srvName + '.',
        suffix: '',
        globalize: false,
        cacheDns: true,
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
    statsd.makeChild = function(name) {
        var childOptions = objectAssign({}, options);
        childOptions._prefix = statsdOptions.prefix + normalizeName(name);
        return makeStatsD(childOptions, logger);
    };

    // Add a static utility method for stat name normalization
    statsd.normalizeName = normalizeName;

    // Also add a small utility to send a delta given a startTime
    statsd.endTiming = function endTiming(names, startTime, samplingInterval) {
        return this.timing(names, Date.now() - startTime, samplingInterval);
    };

    return statsd;
}

module.exports = makeStatsD;
