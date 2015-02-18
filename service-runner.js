#!/usr/bin/env node
/**
 * Fairly generic cluster-based web service runner. Starts several instances
 * of a worker module (in this case the restface module), and manages restart
 * and graceful shutdown. The worker module can also be started independently,
 * which is especially useful for debugging.
 */
"use strict";

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
var StatsD = require('./lib/statsd');


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
}

ServiceRunner.prototype.run = function run (conf) {
    var self = this;
    return this.updateConfig(conf)
    .then(function() {
        var config = self.config;
        var name = config.info && config.info.name || 'service-runner';
        // Set up the logger
        if (!config.logging.name) {
            config.logging.name = name;
        }
        self._logger = new Logger(config.logging);
        // And the statsd client
        config.metrics.name = name;
        self._metrics = new StatsD(config.metrics);

        if (cluster.isMaster && config.num_workers > 0) {
            return self._runMaster();
        } else {
            return self._runWorker();
        }
    });
};

ServiceRunner.prototype._sanitizeConfig = function (conf, options) {
    // TODO: Perform proper validation!
    if (!conf.logging) { conf.logging = {}; }
    if (!conf.metrics) { conf.metrics = {}; }
    // check the number of workers to run
    if(options.num_workers !== -1) {
        // the number of workers has been supplied
        // on the command line, so honour that
        conf.num_workers = options.num_workers;
    } else if(conf.num_workers === 'ncpu' || typeof conf.num_workers !== 'number') {
        // use the number of CPUs
        conf.num_workers = os.cpus().length;
    }
    return conf;
};

ServiceRunner.prototype.updateConfig = function updateConfig (conf) {
    var self = this;
    if (conf) {
        self.config = this._sanitizeConfig(conf, self.options);
        return P.resolve(conf);
    } else {
        var configFile = this.options.configFile;
        if (/^\./.test(configFile)) {
            // resolve relative paths
            configFile = path.resolve(self._basePath + '/' + configFile);
        }
        return fs.readFileAsync(configFile)
        .then(function(yamlSource) {
            self.config = self._sanitizeConfig(yaml.safeLoad(yamlSource), self.options);
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

    for (var i = 0; i < this.config.num_workers; i++) {
        cluster.fork();
    }

    cluster.on('exit', function(worker, code, signal) {
        if (!worker.suicide) {
            var exitCode = worker.process.exitCode;
            self._logger.log('error/service-runner/master',
                    'worker' + worker.process.pid
                    + 'died (' + exitCode + '), restarting.');
            cluster.fork();
        }
    });

    var shutdown_master = function() {
        self._logger.log('info/service-runner/master', 'master shutting down, killing workers');
        cluster.disconnect(function() {
            self._logger.log('info/service-runner/master', 'Exiting master');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown_master);
    process.on('SIGTERM', shutdown_master);
};

ServiceRunner.prototype._runWorker = function() {
    var self = this;
    // Worker.
    process.on('SIGTERM', function() {
        self._logger.log('info/service-runner/worker', 'Worker ' + process.pid + ' shutting down');
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
    .catch(function(e) {
        self._logger.log('fatal/service-runner/worker', e);
        process.exit(1);
    });
};


ServiceRunner.prototype._getOptions = function (opts) {
    // check process arguments
    var argParser = require( "yargs" )
        .usage( "Usage: $0 [-h|-v] [--param[=val]]" )
        .default({

            // Start a few more workers than there are cpus visible to the OS,
            // so that we get some degree of parallelism even on single-core
            // systems. A single long-running request would otherwise hold up
            // all concurrent short requests.
            n: -1,
            c: './config.yaml',

            v: false,
            h: false

        })
        .boolean( [ "h", "v" ] )
            .alias( "h", "help" )
            .alias( "v", "version" )
            .alias( "c", "config" )
            .alias( "n", "num-workers" );
    var args = argParser.argv;

    // help
    if ( args.h ) {
        argParser.showHelp();
        process.exit( 0 );
    }

    // version
    if ( args.v ) {
        var meta = require( path.join( __dirname, "./package.json" ) );
        console.log( meta.name + " " + meta.version );
        process.exit( 0 );
    }


    if (!opts) {
        // Use args
        opts = {
            num_workers: args.n,
            configFile: args.c
        };
    }

    return opts;
};




module.exports = ServiceRunner;


if (module.parent === null) {
    // Run as a script: Start up
    return new ServiceRunner().run();
}
