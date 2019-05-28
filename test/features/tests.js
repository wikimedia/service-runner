'use strict';

const TestServer = require('../TestServer');
const cluster = require('cluster');
const assert = require('assert');

describe('service-runner tests', () => {
    it('Must start and stop a simple service, no workers', () => {
        const server = new TestServer(`${__dirname}/../utils/simple_config_no_workers.yaml`);
        return server.start()
        .then(() => {
            assert.strictEqual(Object.keys(cluster.workers).length, 0, 'Must have 0 workers');
        })
        .finally(() => server.stop());
    });

    it('Must start and stop a simple service, one worker', () => {
        const server = new TestServer(`${__dirname}/../utils/simple_config_one_worker.yaml`);
        return server.start()
        .then(() => {
            assert.strictEqual(Object.keys(cluster.workers).length, 1, 'Must have 1 worker');
        })
        .finally(() => server.stop());
    });

    it('Must start and stop a simple service, two workers', () => {
        const server = new TestServer(`${__dirname}/../utils/simple_config_two_workers.yaml`);
        return server.start()
        .then(() => {
            assert.strictEqual(Object.keys(cluster.workers).length, 2, 'Must have 2 workers');
        })
        .finally(() => server.stop());
    });

    it('Must restart a worker if it dies', () => {
        const server = new TestServer(`${__dirname}/../utils/simple_config_one_worker.yaml`);
        let firstWorkerId;
        return server.start()
        .then(() => {
            assert.strictEqual(Object.keys(cluster.workers).length, 1, 'Must have 1 worker');
            const worker = cluster.workers[Object.keys(cluster.workers)[0]];
            firstWorkerId = worker.process.pid;
            worker.process.kill('SIGKILL');
        })
        .delay(2000)
        .then(() => {
            assert.strictEqual(Object.keys(cluster.workers).length, 1, 'Must have 1 worker');
            const worker = cluster.workers[Object.keys(cluster.workers)[0]];
            assert.notStrictEqual(worker.process.pid, firstWorkerId, 'Must create a new worker');
        })
        .finally(() => server.stop());
    });

    it('Must support rolling restart on SIGHUP', () => {
        const server = new TestServer(`${__dirname}/../utils/simple_config_two_workers.yaml`);
        let firstWorkerIDs;
        return server.start()
        .then(() => {
            firstWorkerIDs = Object.keys(cluster.workers);
            assert.strictEqual(firstWorkerIDs.length, 2, 'Must have 2 workers');
            process.kill(process.pid, 'SIGHUP');
        })
        .delay(2000)
        .then(() => {
            const workerIDs = Object.keys(cluster.workers);
            assert.strictEqual(workerIDs.length, 2, 'Must have 2 workers after restart');
            workerIDs.forEach((id) => {
                assert.strictEqual(firstWorkerIDs.indexOf(id), -1,
                    `Worker ${id} must have restarted`);
            });
        })
        .finally(() => server.stop());
    });

    it('Must remove all listeners on stop', (done) => {
        const DEFAULT_MAX_LISTENERS = require('events').EventEmitter.defaultMaxListeners;
        const server = new TestServer(`${__dirname}/../utils/simple_config_two_workers.yaml`);
        const warningListener = (warning) => {
            if (!done.called) {
                done.called = true;
                done(warning);
            }
        };
        process.on('warning', warningListener);
        let counter = 0;
        const startStop = () => {
            if (counter++ === DEFAULT_MAX_LISTENERS) {
                return;
            }
            return server.start()
            .then(() => server.stop())
            .then(startStop);
        };
        startStop()
        .then(() => {
            if (!done.called) {
                done.called = true;
                done();
            }
        })
        .finally(() => process.removeListener('warning', warningListener));
    });
}, 'service-runner tests');
