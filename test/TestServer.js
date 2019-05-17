'use strict';

const P = require('bluebird');
const ServiceRunner = require('../service-runner');

class TestServer {
    constructor(configPath) {
        if (!configPath) {
            throw new Error('Config path must be provided to the test runner');
        }
        this._configPath = configPath;
        this._running = false;
        this._runner = new ServiceRunner({
            configFile: this._configPath
        });
        this._services = undefined;
        this._startupRetriesRemaining = 3;
    }

    start() {
        if (this._running) {
            console.log('The test server is already running. Skipping start.');
            return P.resolve(this._services);
        }

        return this._runner.start()
        .tap((result) => {
            this._running = true;
            this._services = result;
        })
        .catch((e) => {
            if (this._startupRetriesRemaining > 0 && /EADDRINUSE/.test(e.message)) {
                console.log('Execution of the previous test might have not finished yet. Retry startup');
                this._startupRetriesRemaining--;
                return P.delay(1000).then(() => this.start());
            }
            throw e;
        });
    }

    stop() {
        if (this._running) {
            return this._runner.stop()
            .tap(() => {
                this._running = false;
            });
        }
        return P.resolve();
    }
}

module.exports = TestServer;
