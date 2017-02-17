'use strict';
var cluster = require('cluster');

var RateLimiter = require('limitation');

/**
 * Cluster master RateLimiter wrapper
 */
function RateLimiterMaster(options) {
    var self = this;
    this._limiter = new RateLimiter(options);
    this._limiter.on('blocks', function(blocks) {
        self._sendBlocksToWorkers(blocks);
    });
}

RateLimiterMaster.prototype.stop = function() {
    this._limiter.stop();
};

RateLimiterMaster.prototype._sendBlocksToWorkers = function(blocks) {
    var workers = cluster.workers;
    Object.keys(workers).forEach(function(key) {
        var worker = workers[key];
        if (worker) {
            try {
                worker.send({
                    type: 'ratelimiter_blocks',
                    value: blocks,
                });
            } catch (e) {}
        }
    });
};


/**
 * Initialize the internal limiter.
 * @return {Promise<RateLimiter>}
 */
RateLimiterMaster.prototype.setup = function() {
    return this._limiter.setup();
};

RateLimiterMaster.prototype.updateCounters = function(counters) {
    var keys = Object.keys(counters);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var counter = counters[key];
        var limits = Object.keys(counter.limits);
        var minLimit = Math.min.apply(null, limits);
        this._limiter.isAboveLimit(key, minLimit, counter.value);
    }
};

/**
 * Cluster worker side RateLimiter
 *
 * Performs local checks, and communicates with the actual rate limiter in the
 * master process.
 */
function RateLimiterWorker(options) {
    var self = this;
    this._interval = options && options.interval || 5000;
    // Local counters and blocks. Contain objects with `value` and `limits`
    // properties.
    this._counters = {};
    this._blocks = {};

    // Start the periodic send-to-master process in the background.
    this._sendInterval = setInterval(function() {
        self._sendToMaster();
    }, self._interval);
}

RateLimiterWorker.prototype.stop = function() {
    clearInterval(this._sendInterval);
};

/**
 * Send current counters to the master process.
 */
RateLimiterWorker.prototype._sendToMaster = function() {
    var counters = this._counters;
    this._counters = {};
    process.send({
        type: 'ratelimiter_counters',
        value: counters
    });
};

RateLimiterWorker.prototype._updateBlocks = function(blocks) {
    this._blocks = blocks;
};


/**
 * Synchronous limit check
 *
 * @param {string} key
 * @param {number} limit
 * @param {number} increment, default 1
 * @return {boolean}: `true` if the request rate is below the limit, `false`
 * if the limit is exceeded.
 */
RateLimiterWorker.prototype.isAboveLimit = function(key, limit, increment) {
    var counter = this._counters[key];
    if (!counter) {
        counter = this._counters[key] = {
            value: 0,
            limits: {},
        };
    }
    counter.value += increment || 1;
    counter.limits[limit] = counter.limits[limit] || Date.now();

    if (this._blocks[key]) {
        return this._blocks[key].value > limit;
    } else {
        return false;
    }
};

/**
 * Checks whether we're above the limit without updating the counters.
 *
 * @param {string} key
 * @param {number} limit
 */
RateLimiterWorker.prototype.checkAboveLimit = function(key, limit) {
    if (this._blocks[key]) {
        return this._blocks[key].value > limit;
    } else {
        return false;
    }
};

module.exports = {
    master: RateLimiterMaster,
    worker: RateLimiterWorker,
    nocluster: RateLimiter,
};
