"use strict";
var TXStatsD = require('node-txstatsd');
var StatsD = require('node-statsd');

var nameCache = {};
function normalizeName (name) {
    // See https://github.com/etsy/statsd/issues/110
    // Only [\w_.-] allowed, with '.' being the hierarchy separator.
    var res = nameCache[name];
    if (res) {
        return res;
    } else {
        nameCache[name] = name.replace( /[^\/a-zA-Z0-9\.\-]/g, '-' )
            .replace(/\//g, '_');
        return nameCache[name];
    }
}

// Minimal StatsD wrapper
function makeStatsD(options) {
    var statsd;
    var statsdOptions = {
        host: options.host,
        port: options.port,
        prefix: options.name + '.',
        suffix: '',
        txstatsd  : true,
        globalize : false,
        cacheDns  : true,
        mock      : false
    };
    if (options.type === 'txstatsd') {
        statsd = new TXStatsD(statsdOptions);
    } else {
        statsd = new StatsD(statsdOptions);
    }

    // Add a static utility method for stat name normalization
    statsd.normalizeName = normalizeName;

    // Also add a small utility to send a delta given a startTime
    statsd.endTiming = function endTiming(names, startTime, samplingInterval) {
        return this.timing(names, Date.now() - startTime, samplingInterval);
    };

    return statsd;
}

module.exports = makeStatsD;
