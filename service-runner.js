#!/usr/bin/env node
/**
 * Fairly generic cluster-based web service runner. Starts several instances
 * of a worker module (in this case the restface module), and manages restart
 * and graceful shutdown. The worker module can also be started independently,
 * which is especially useful for debugging.
 */
'use strict';

// Upgrade to es6
require('core-js/shim');

// Use bluebird internally. Use P.resolve(es6Promise) to convert an incoming
// Promise to a bluebird Promise.
var P = require('bluebird');

var cluster = require('cluster');
var path = require('path');
var yaml = require('js-yaml');
var fs = P.promisifyAll(require('fs'));
var os = require('os');

var Logger = require('./lib/logger');
var makeStatsD = require('./lib/statsd');
var HeapWatch = require('./lib/heapwatch');
var docker = require('./lib/docker');

// Disable cluster RR balancing; direct socket sharing has better throughput /
// lower overhead. Also bump up somaxconn with this command:
// sudo sysctl -w net.core.somaxconn=4096
cluster.schedulingPolicy = cluster.SCHED_NONE;

function ServiceRunner(options) {
    this.options = this._getOptions(options);

    this._config = null;
    this._logger = null;
    this._metrics = null;

    // Figure out the base path
    this._basePath = /\/node_modules\/service-runner$/.test(__dirname) ?
        path.resolve(__dirname + '/../../') : path.resolve('./');

    // Is the master shutting down?
    this._shuttingDown = false;

    // Are we performing a rolling restart?
    this._inRollingRestart = false;
}

ServiceRunner.prototype.run = function run(conf) {
    var self = this;
    return this.updateConfig(conf)
    .then(function() {
        var config = self.config;
        var name = config.package && config.package.name || 'service-runner';

        // display the version
        if (self.options.displayVersion) {
            console.log(name + ' ' + config.package.version);
            process.exit(0);
        }

        // do we need to use Docker instead of starting normally ?
        if (self.options.useDocker) {
            self.options.basePath = self._basePath;
            return docker(self.options, self.config);
        }

        // Set up the logger
        if (!config.logging.name) {
            config.logging.name = name;
        }
        self._logger = new Logger(config.logging);

        // And the statsd client
        if (!config.metrics.name) {
            config.metrics.name = name;
        }
        self._metrics = makeStatsD(config.metrics, self._logger);

        if (cluster.isMaster && config.num_workers > 0) {
            return self._runMaster();
        } else {
            return self._runWorker();
        }
    });
};

ServiceRunner.prototype._sanitizeConfig = function(conf, options) {
    // TODO: Perform proper validation!
    if (!conf.logging) { conf.logging = {}; }
    if (!conf.metrics) { conf.metrics = {}; }
    // check the number of workers to run
    if (options.num_workers !== -1) {
        // the number of workers has been supplied
        // on the command line, so honour that
        conf.num_workers = options.num_workers;
    } else if (conf.num_workers === 'ncpu' || typeof conf.num_workers !== 'number') {
        // use the number of CPUs
        conf.num_workers = os.cpus().length;
    }
    return conf;
};

ServiceRunner.prototype.updateConfig = function updateConfig(conf) {
    var self = this;
    if (conf) {
        self.config = this._sanitizeConfig(conf, self.options);
        return P.resolve(conf);
    } else {
        var package_json = {};
        try {
            package_json = require(self._basePath + '/' + 'package.json');
        } catch (e) {}

        var configFile = this.options.configFile;
        if (/^\./.test(configFile)) {
            // resolve relative paths
            configFile = path.resolve(self._basePath + '/' + configFile);
        }
        return fs.readFileAsync(configFile)
        .then(function(yamlSource) {
            self.config = self._sanitizeConfig(yaml.safeLoad(yamlSource),
                    self.options);

            // Make sure we have a sane config object by pulling in
            // package.json info if necessary
            var config = self.config;
            config.package = package_json;
            if (config.info) {
                // for backwards compat
                var pack = config.package;
                pack.name = config.info.name || pack.name;
                pack.description = config.info.description || pack.description;
                pack.version = config.version || pack.version;
            }
        })
        .catch(function(e) {
            console.error('Error while reading config file: ' + e);
            process.exit(1);
        });
    }
};

ServiceRunner.prototype._runMaster = function() {
    var self = this;
    // Fork workers.
    this._logger.log('info/service-runner', 'master(' + process.pid + ') initializing '
            + this.config.num_workers + ' workers');

    cluster.on('exit', function(worker, code, signal) {
        if (!self._shuttingDown && !self._inRollingRestart) {
            var exitCode = worker.process.exitCode;
            self._logger.log('error/service-runner/master',
                    'worker' + worker.process.pid
                    + 'died (' + exitCode + '), restarting.');
            P.delay(Math.random() * 2000)
            .then(function() {
                cluster.fork();
            });
        }
    });

    var shutdown_master = function() {
        self._shuttingDown = true;
        self._logger.log('info/service-runner/master',
                'master shutting down, killing workers');
        cluster.disconnect(function() {
            self._logger.log('info/service-runner/master', 'Exiting master');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown_master);
    process.on('SIGTERM', shutdown_master);

    // Set up rolling restarts
    process.on('SIGHUP', this._rollingRestart.bind(this));

    return this._startWorkers(this.config.num_workers);
};

ServiceRunner.prototype._stopWorker = function(id) {
    var worker = cluster.workers[id];
    var res = new P(function(resolve) {
        var timeout = setTimeout(function() {
            worker.kill('SIGKILL');
            resolve();
        }, 60000);
        worker.on('disconnect', function() {
            worker.kill('SIGKILL');
            clearTimeout(timeout);
            resolve();
        });
    });
    worker.disconnect();
    return res;
};

ServiceRunner.prototype._rollingRestart = function() {
    this._logger.log('info/service-runner/master', {
        message: 'SIGHUP received, performing rolling restart of workers'
    });
    var self = this;
    self._inRollingRestart = true;
    P.each(Object.keys(cluster.workers), function(workerId) {
        return self._stopWorker(workerId)
        .then(function() {
            return self._startWorkers(1);
        });
    })
    .then(function() {
        self._inRollingRestart = false;
    });
};

// Fork off one worker at a time, once the previous worker has finished
// startup.
ServiceRunner.prototype._startWorkers = function(remainingWorkers, msg) {
    var self = this;
    if (remainingWorkers
            && (!msg || msg.type === 'startup_finished')) {
        var worker = cluster.fork();
        return new P(function(resolve) {
            worker.on('message', function() {
                resolve(self._startWorkers(--remainingWorkers));
            });
        });
    }
};

ServiceRunner.prototype._runWorker = function() {
    var self = this;
    // Worker.
    process.on('SIGTERM', function() {
        self._logger.log('info/service-runner/worker', 'Worker '
                + process.pid + ' shutting down');
        process.exit(0);
    });

    // Enable heap dumps in /tmp on kill -USR2.
    // See https://github.com/bnoordhuis/node-heapdump/
    // For node 0.6/0.8: npm install heapdump@0.1.0
    // For 0.10: npm install heapdump
    process.on('SIGUSR2', function() {
        var heapdump = require('heapdump');
        var cwd = process.cwd();
        console.error('SIGUSR2 received! Writing snapshot.');
        process.chdir('/tmp');
        heapdump.writeSnapshot();
        process.chdir(cwd);
    });

    // Heap limiting
    // We try to restart workers before they get slow
    // Default to something close to the default node 2g limit
    var limitMB = parseInt(self.config.worker_heap_limit_mb) || 1500;
    new HeapWatch({ limitMB: limitMB },
            this._logger,
            this._metrics).watch();

    // Require service modules and start them
    return P.all(this.config.services.map(function(service) {
        var modName = service.module || service.name;
        if (/^\./.test(modName)) {
            // resolve relative paths
            modName = path.resolve(self._basePath + '/' + modName);
        }
        var svcMod;
        try {
            svcMod = require(modName);
        } catch (e) {
            e.moduleName = modName;
            return P.reject(e);
        }

        var opts = {
            config: service.conf,
            logger: self._logger.child({
                name: service.name || service.module,
            }),
            // todo: set up custom prefix
            metrics: self._metrics
        };

        return P.try(function() {
            return svcMod(opts);
        });
    }))
    .then(function(res) {
        // Signal that this worker finished startup
        if (cluster.isWorker) {
            process.send({type: 'startup_finished'});
        }
        return res;
    })
    .catch(function(e) {
        self._logger.log('fatal/service-runner/worker', e);
        process.exit(1);
    });
};

ServiceRunner.prototype._getOptions = function(opts) {

    if (opts) {
        // no need to parse command-line args,
        // opts are already here
        return opts;
    }

    // check process arguments
    var args = require('yargs')
        .usage('Usage: $0 [command] [options]')
        .command('docker-start', 'starts the service in a Docker container')
        .command('docker-test', 'starts the test process in a Docker container')
        .command('build', 'builds the service\'s package and deploy repo')
        .options({
            n: {
                alias: 'num-workers',
                default: -1,
                describe: 'number of workers to start',
                nargs: 1
            },
            c: {
                alias: 'config',
                default: './config.yaml',
                describe: 'YAML-formatted configuration file',
                type: 'string',
                nargs: 1
            },
            f: {
                alias: 'force',
                default: false,
                describe: 'force the operation to execute',
                type: 'boolean'
            },
            d: {
                alias: 'deploy-repo',
                default: false,
                describe: 'build only the deploy repo',
                type: 'boolean'
            },
            r: {
                alias: 'review',
                default: false,
                describe: 'send the patch to Gerrit after building the repo',
                type: 'boolean'
            },
            verbose: {
                default: false,
                describe: 'be verbose',
                type: 'boolean'
            },
            v: {
                alias: 'version',
                default: false,
                describe: 'print the service\'s version and exit',
                type: 'boolean'
            },
        })
        .help('h')
        .alias('h', 'help')
        .argv;

    args.deployRepo = args.deployRepo || args.review;
    args.build = args._.includes('build') || args.deployRepo;
    args.dockerStart = args._.includes('docker-start');
    args.dockerTest = args._.includes('docker-test');
    args.deployRepo = args.deployRepo || args.build;

    if (args.build && args.dockerStart || args.build && args.dockerTest
            || args.dockerStart && args.dockerTest) {
        console.error('Only one command can be specified!');
        process.exit(1);
    }

    opts = {
        num_workers: args.numWorkers,
        configFile: args.config,
        displayVersion: args.v,
        build: args.build,
        buildDeploy: args.deployRepo,
        sendReview: args.review,
        dockerStart: args.dockerStart,
        dockerTest: args.dockerTest,
        useDocker: args.deployRepo || args.dockerStart || args.dockerTest,
        force: args.force,
        verbose: args.verbose
    };

    return opts;
};

module.exports = ServiceRunner;

if (module.parent === null) {
    // Run as a script: Start up
    return new ServiceRunner().run();
}
