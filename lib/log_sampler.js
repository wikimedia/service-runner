"use strict";

/**
 * Creates a log sampler. In case the log rate is not exceeded, all the logs
 * are being written. Otherwise starts sampling the logs with decreasing
 * probability.
 *
 * @param {object} options:
 * @param {Number} [options.limit] The maximum rate of sampled logs per interval. Default: 1000.
 * @param {Number} [options.interval] Update interval in ms. Default: 1000ms.
 * @param {Number} [options.minValue] Drop global counters below this value. Default: 10.
 */
function Sampler(options) {
    this._options = options === true ? {} : options || {};
    this._options.limit = this._options.limit || 1000;
    this._options.interval = this._options.interval || 1000;
    this._options.minValue = this._options.minValue || 10;
    // TODO: replace with a native Map when support for node 0.10 is dropped.
    this._counters = {};
    // Exponential decay with factor 2, thrice per interval for better
    // smoothness, using the cubic root of 2).
    this._decayFactor = Math.pow(2, 1/3);
    this._decayedLimit = this._options.limit / this._decayFactor;
    this._decayInterval = setInterval(this._decay.bind(this), this._options.interval / 3);
}

Sampler.prototype._decay = function() {
    var self = this;
    var minValue = self._options.minValue;
    Object.keys(self._counters).forEach(function(key) {
        self._counters[key] /= self._decayFactor;
        if (self._counters[key] < minValue) {
            delete self._counters[key];
        }
    });
};

Sampler.prototype._increment = function(logClass) {
    this._counters[logClass] = this._counters[logClass] ? this._counters[logClass] + 1 : 1;
};

Sampler.prototype.shouldLog = function(logClass) {
    this._increment(logClass);
    var currentCount = this._counters[logClass];
    if (currentCount < this._decayedLimit) {
        // If it's not close to the limit yet - don't sample.
        return true;
    } else {
        // We decay by 2 each interval, so the counter is roughly 1.5 time larger
        // then continuous rate.
        return Math.random() < 1.5 * this._decayedLimit / currentCount;
    }
};

Sampler.prototype.stop = function() {
    clearInterval(this._decayInterval);
};

module.exports = Sampler;