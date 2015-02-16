"use strict";
var TXStatsD = require('node-txstatsd');

// StatsD wrapper
function StatsD(options) {
    this.statsd = new TXStatsD({
        host: options.host,
        port: options.port,
        prefix: options.name + '.',
        suffix: '',
        txstatsd  : true,
        globalize : false,
        cacheDns  : true,
        mock      : false
    });

    this.nameCache = {};
}

StatsD.prototype.makeName = function makeName(name) {
    // See https://github.com/etsy/statsd/issues/110
    // Only [\w_.-] allowed, with '.' being the hierarchy separator.
    var res = this.nameCache[name];
    if (res) {
        return res;
    } else {
        this.nameCache[name] = name.replace( /[^\/a-zA-Z0-9\.\-]/g, '-' )
               .replace(/\//g, '_');
        return this.nameCache[name];
    }
};

StatsD.prototype.timing = function timing(name, suffix, delta) {
    name = this.makeName(name);
    if (Array.isArray(suffix)) {
        // Send several timings at once
        var stats = suffix.map(function(s) {
            return name + (s ? '.' + s : '');
        });
        this.statsd.sendAll(stats, delta, 'ms');
    } else {
        suffix = suffix ? '.' + suffix : '';
        this.statsd.timing(name + suffix, delta);
    }
    return delta;
};

StatsD.prototype.endTiming = function endTiming(name, suffix, start) {
    return this.timing(name, suffix, Date.now() - start);
};

StatsD.prototype.count = function count(name, suffix) {
    suffix = suffix ? '.' + suffix : '';
    this.statsd.increment(this.makeName(name) + suffix);
};

module.exports = StatsD;
