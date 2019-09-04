'use strict';

const http = require('http');
const P = require('bluebird');

module.exports = (options) => {
    if (options.prometheus) {
        this.hitcounter = new options.prometheus.Counter({
            name: 'hitcount',
            help: 'a hit counter',
            labelNames: ['worker_id']
        });
    }

    const server = http.createServer((req, res) => {
        if (this.hitcounter) {
            this.hitcounter.labels(options.config.worker_id).inc();
        }
        if (options.metrics) {
            options.metrics.increment(`${options.config.worker_id}.hitcount`);
        }
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
