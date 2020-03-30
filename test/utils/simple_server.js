'use strict';

const http = require('http');
const P = require('bluebird');

module.exports = (options) => {
    const server = http.createServer((req, res) => {
        // supported interface
        options.metrics.makeMetric({
            type: 'Counter',
            name: 'simple_server.hitcount',
            prometheus: {
                name: 'hitcount',
                help: 'a hit counter'
            },
            labels: {
                names: ['worker_id']
            }
        }).increment(1, [options.config.worker_id]);
        options.metrics.makeMetric({
            type: 'Counter',
            name: 'simple_server.hitcount.total',
            prometheus: {
                name: 'hitcount total',
                help: 'a hit counter'
            }
        }).increment();
        // deprecated interface
        options.metrics.increment(`simple_server.deprecated_interface.worker_${options.config.worker_id}.hitcount`);
        res.end('ok\n');
    });
    return new P((resolve, reject) => {
        server.listen(options.config.port, 'localhost', (err) => {
            if (err) {
                return reject(err);
            }
            return resolve(server);
        });
    });
};
