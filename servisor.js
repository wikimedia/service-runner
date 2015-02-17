#!/usr/bin/env node
/**
 * Fairly generic cluster-based web service runner. Starts several instances
 * of a worker module (in this case the restface module), and manages restart
 * and graceful shutdown. The worker module can also be started independently,
 * which is especially useful for debugging.
 */
"use strict";

// Upgrade to es6
require('./lib/es6');

var cluster = require('cluster');
var path = require('path');
var yaml = require('js-yaml');
var fs = Promise.promisifyAll(require('fs'));


var Logger = require('./lib/logger');
var StatsD = require('./lib/statsd');


// Disable cluster RR balancing; direct socket sharing has better throughput /
// lower overhead. Also bump up somaxconn with this command:
// sudo sysctl -w net.core.somaxconn=4096
cluster.schedulingPolicy = cluster.SCHED_NONE;


function Servisor(options) {
    this.options = this._getOptions(options);

    this._config = null;
    this._logger = null;
    this._metrics = null;
}

Servisor.prototype.run = function run (conf) {
    var self = this;
    return this.updateConfig(conf)
    .then(function() {
        var config = self.config;
        var name = config.info && config.info.name || 'servisor';
        // Set up the logger
        if (!config.logging.name) {
            config.logging.name = name;
        }
        self._logger = new Logger(config.logging);
        // And the statsd client
        config.metrics.name = name;
        self._metrics = new StatsD(config.metrics);

        if (cluster.isMaster && config.numWorkers > 0) {
            return self._runMaster();
        } else {
            return self._runWorker();
        }
    });
};

Servisor.prototype._sanitizeConfig = function (conf) {
    // TODO: Perform proper validation!
    if (!conf.logging) { conf.logging = {}; }
    if (!conf.metrics) { conf.metrics = {}; }
    if (conf.numWorkers === undefined) {
        // Let the config win, but respect the parameter
        conf.numWorkers = this.options.numWorkers;
    }
    return conf;
};

Servisor.prototype.updateConfig = function updateConfig (conf) {
    var self = this;
    if (conf) {
        self.config = this._sanitizeConfig(conf);
        return Promise.resolve(conf);
    } else {
        var configFile = this.options.configFile;
        if (/^\./.test(configFile)) {
            // resolve relative paths
            configFile = path.resolve(configFile);
        }
        return fs.readFileAsync(configFile)
        .then(function(yamlSource) {
            self.config = self._sanitizeConfig(yaml.safeLoad(yamlSource));
        })
        .catch(function(e) {
            console.error('Error while reading config file: ' + e);
            process.exit(1);
        });
    }
};

Servisor.prototype._runMaster = function() {
    var self = this;
    // Fork workers.
    this._logger.log('info/servisor', 'master(' + process.pid + ') initializing '
            + this.config.numWorkers + ' workers');

    for (var i = 0; i < this.config.numWorkers; i++) {
        cluster.fork();
    }

    cluster.on('exit', function(worker, code, signal) {
        if (!worker.suicide) {
            var exitCode = worker.process.exitCode;
            self._logger.log('error/servisor/master',
                    'worker' + worker.process.pid
                    + 'died (' + exitCode + '), restarting.');
            cluster.fork();
        }
    });

    var shutdown_master = function() {
        self._logger.log('info/servisor/master', 'master shutting down, killing workers');
        cluster.disconnect(function() {
            self._logger.log('info/servisor/master', 'Exiting master');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown_master);
    process.on('SIGTERM', shutdown_master);
};

Servisor.prototype._runWorker = function() {
    var self = this;
    // Worker.
    process.on('SIGTERM', function() {
        self._logger.log('info/servisor/worker', 'Worker ' + process.pid + ' shutting down');
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
    return Promise.all(this.config.services.map(function(service) {
        var modName = service.module || service.name;
        if (/^\./.test(modName)) {
            // resolve relative paths
            modName = path.resolve(modName);
        }
        var svcMod;
        try {
            svcMod = require(modName);
        } catch (e) {
            e.moduleName = modName;
            return Promise.reject(e);
        }

        var opts = {
            config: service.conf,
            logger: self._logger.child({
                name: service.name || service.module,
            }),
            // todo: set up custom prefix
            metrics: self._metrics
        };

        return Promise.try(function() {
            return svcMod(opts);
        });
    }))
    .catch(function(e) {
        self._logger.log('fatal/servisor/worker', e);
        process.exit(1);
    });
};


Servisor.prototype._getOptions = function (opts) {
    // check process arguments
    var args = require( "yargs" )
        .usage( "Usage: $0 [-h|-v] [--param[=val]]" )
        .default({

            // Start a few more workers than there are cpus visible to the OS,
            // so that we get some degree of parallelism even on single-core
            // systems. A single long-running request would otherwise hold up
            // all concurrent short requests.
            n: require("os").cpus().length,
            c: './config.yaml',

            v: false,
            h: false

        })
        .boolean( [ "h", "v" ] )
            .alias( "h", "help" )
            .alias( "v", "version" )
            .alias( "c", "config" )
            .alias( "n", "num-workers" )
        .argv;

    // help
    if ( args.h ) {
        opts.showHelp();
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
            numWorkers: args.n,
            configFile: args.c
        };
    }

    return opts;
};




module.exports = Servisor;


if (module.parent === null) {
    // Run as a script: Start up
    return new Servisor().run();
}
