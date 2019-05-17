'use strict';

const http = require('http');
const P = require('bluebird');

module.exports = (options) => {
    const server = http.createServer((req, res) => res.end());
    return new P((resolve, reject) => {
        server.listen(options.config.port, 'localhost', (err) => {
            if (err) {
                return reject(err);
            }
            return resolve(server);
        });
    });
};
