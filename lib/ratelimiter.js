'use strict';

const cluster = require('cluster');

const RateLimiter = require('limitation');

/**
 * Cluster master RateLimiter wrapper
 */
class RateLimiterMaster {
    constructor(options) {
        this._limiter = new RateLimiter(options);
        this._limiter.on('blocks', (blocks) => this._sendBlocksToWorkers(blocks));
    }

    stop() {
        this._limiter.stop();
    }

    _sendBlocksToWorkers(blocks) {
        const workers = cluster.workers;
        Object.keys(workers).forEach((key) => {
            const worker = workers[key];
            if (worker) {
                try {
                    worker.send({
                        type: 'ratelimiter_blocks',
                        value: blocks
                    });
                } catch (e) {
                    // Ignore the error
                }
            }
        });
    }

    /**
     * Initialize the internal limiter.
     * @return {Promise<RateLimiter>}
     */
    setup() {
        return this._limiter.setup();
    }

    updateCounters(counters) {
        const keys = Object.keys(counters);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const counter = counters[key];
            const limits = Object.keys(counter.limits);
            const minLimit = Math.min.apply(null, limits);
            this._limiter.isAboveLimit(key, minLimit, counter.value);
        }
    }
}

/**
 * Cluster worker side RateLimiter
 *
 * Performs local checks, and communicates with the actual rate limiter in the
 * master process.
 */
class RateLimiterWorker {
    constructor(options) {
        this._interval = options && options.interval || 5000;
        // Local counters and blocks. Contain objects with `value` and `limits`
        // properties.
        this._counters = {};
        this._blocks = {};

        // Start the periodic send-to-master process in the background.
        this._sendInterval = setInterval(() => {
            this._sendToMaster();
        }, this._interval);
    }

    stop() {
        clearInterval(this._sendInterval);
    }

    /**
     * Send current counters to the master process.
     */
    _sendToMaster() {
        const counters = this._counters;
        this._counters = {};
        process.send({
            type: 'ratelimiter_counters',
            value: counters
        });
    }

    _updateBlocks(blocks) {
        this._blocks = blocks;
    }

    /**
     * Synchronous limit check
     * @param {string} key
     * @param {number} limit
     * @param {number} increment default 1
     * @return {boolean}: `true` if the request rate is below the limit, `false`
     * if the limit is exceeded.
     */
    isAboveLimit(key, limit, increment) {
        let counter = this._counters[key];
        if (!counter) {
            counter = this._counters[key] = {
                value: 0,
                limits: {}
            };
        }
        counter.value += increment || 1;
        counter.limits[limit] = counter.limits[limit] || Date.now();

        if (this._blocks[key]) {
            return this._blocks[key].value > limit;
        } else {
            return false;
        }
    }

    /**
     * Checks whether we're above the limit without updating the counters.
     * @param {string} key
     * @param {number} limit
     * @return {boolean} `true` if above the limit
     */
    checkAboveLimit(key, limit) {
        if (this._blocks[key]) {
            return this._blocks[key].value > limit;
        } else {
            return false;
        }
    }
}

module.exports = {
    master: RateLimiterMaster,
    worker: RateLimiterWorker,
    nocluster: RateLimiter
};
