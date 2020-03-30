'use strict';

const PrometheusClient = require('./prometheus');
const StatsDClient = require('./statsd');
const LogClient = require('./log');
const Metric = require('./metric');
const normalizeName = require('./utils').normalizeName;

const SUPPORTED_CLIENTS = {
    PROMETHEUS: 'prometheus',
    STATSD: 'statsd',
    LOG: 'log'
};

const DEPRECATED_METHODS = ['timing', 'increment', 'decrement', 'gauge', 'unique', 'endTiming'];
const PROXY_LOG_RATE_LIMIT_DURATION = 3600000; // ms
let PROXY_LOG_RATE_LIMIT_TS = 0;

class Metrics {
    constructor(options, logger) {
        this.options = options;
        this.logger = logger;
        this.cache = new Map();
        this.clients = [];
        this.serviceName = 'undefined'; // string to avoid colliding with the Proxy
        if (options.length !== 0) {
            options.forEach((o) => {
                if (this.serviceName === 'undefined' && o.name !== undefined) {
                    this.serviceName = o.name;
                }
                switch (o.type) {
                    case SUPPORTED_CLIENTS.PROMETHEUS:
                        this.clients.push(new PrometheusClient(o, this.logger));
                        break;
                    case SUPPORTED_CLIENTS.STATSD:
                        this.clients.push(new StatsDClient(o, this.logger));
                        break;
                    case SUPPORTED_CLIENTS.LOG:
                        o.methods = DEPRECATED_METHODS;
                        this.clients.push(new LogClient(o, this.logger));
                        break;
                    default:
                        logger.log('error/metrics', `No such metrics client: '${o.type}'`);
                }
            });
        } else {
            // We'll assume we want to log metrics if no outputs are configured
            this.clients.push(new LogClient({}, this.logger));
        }
    }

    getServiceName() {
        return this.serviceName;
    }

    // T247820: Selectively disable service label based on environment variable.
    // Intended for production use case where the service label will be set
    // by the Prometheus server.
    getServiceLabel() {
        if (process.env.METRICS_SERVICE_LABEL_ENABLED === 'false') {
            return {};
        }
        return { service: this.serviceName };
    }

    fetchClient(name) {
        return this.clients.find((client) => {
            return client.constructor.name === name;
        });
    }

// Example Options:
// {
//     type: 'Counter',
//     name: 'hitcount',
//     prometheus: {
//         name: 'hitcount',
//         help: 'hit count',
//         staticLabels: {},  // a key-value pair of labels
//         buckets: [], // https://github.com/siimon/prom-client#histogram
//         percentiles: [], // https://github.com/siimon/prom-client#summary
//     },
//     sampleRate: 1, // default 1 https://github.com/brightcove/hot-shots/blob/v6.3.0/README.md#usage
//     labels: {
//         names: [],
//         labelPosition: 'before',
//         omitLabelNames: false
//     }
// }
    makeMetric(options) {
        let metric = this.cache.get(options.name);
        if (metric === undefined) {
            metric = new Metric(this.clients, this.logger, options);
            this.cache.set(options.name, metric);
        }
        return metric;
    }

    close() {
        this.clients.forEach((o) => o.close());
        this.clients = [];
    }
}

// To preserve backwards compatibility, a subset of statsd and log clients
// methods are mapped into the proxy interface and a warning logged.
// Also log attempts to use unknown/unmapped functions.
// Example Options:
// [
//     {
//         type: 'log',
//         name: 'service-runner'
//     },
//     {
//         type: 'statsd',
//         host: 'localhost',
//         port: '8125',
//         name: 'service-runner'
//     },
//     {
//         type: 'prometheus',
//         port: 9000,
//         name: 'service-runner'
//     }
// ]
function makeMetrics(options, logger) {
    const metrics = new Metrics(options, logger);
    const handler = {
        get: function (target, prop) {
            if (target[prop] === undefined) {
                logger.log('error/metrics', `No such method '${prop.toString()}' in Metrics`);
                return function () {};
            } else {
                return target[prop];
            }
        }
    };
    const proxy = new Proxy(metrics, handler);

    // wrapper to rate-limit proxy metrics logging to once per hour
    proxy.log = function (level, message) {
        const now = Date.now();
        if (PROXY_LOG_RATE_LIMIT_TS < (now - PROXY_LOG_RATE_LIMIT_DURATION)) {
            this.logger.log(level, message);
            PROXY_LOG_RATE_LIMIT_TS = now;
        }
    };

    // The metrics interface exposed the statsd clients directly
    // and many dependent applications use these functions directly.
    // Build up a backwards-compatible interface by mapping these functions
    // to the Metrics proxy instance.
    DEPRECATED_METHODS.forEach((o) => {
        proxy[o] = function (...args) {
            proxy.log('warn/metrics', `Calling 'Metrics.${o}' directly is deprecated.`);
            metrics.clients.forEach((client) => {
                if (client.constructor.name !== 'PrometheusClient') {
                    client.client[o].apply(client.client, args);
                }
            });
        };
    });

    proxy.normalizeName = normalizeName;

    // Deprecated.
    // Support creating sub-metric clients with a fixed prefix. This is useful
    // for systematically categorizing metrics per-request, by using a
    // specific logger.  WARNING: if both Log and StatsD are configured, only
    // one will be returned.
    proxy.makeChild = function (name) {
        proxy.log('warn/metrics', 'makeChild() is deprecated.');
        for (const client of this.clients) {
            if (client.constructor.name !== 'PrometheusClient') {
                const child = client.childClient();
                child.prefix = `${client.client.prefix}${normalizeName(name)}.`;
                child.normalizeName = normalizeName;
                return child;
            }
        }
    };

    return proxy;
}

module.exports = makeMetrics;
