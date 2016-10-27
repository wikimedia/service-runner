"use strict";

var P = require('bluebird');
var path = require('path');
var yaml = require('js-yaml');
var fs = P.promisifyAll(require('fs'));
var os = require('os');

var Logger = require('./logger');
var docker = require('./docker');

/**
 * Abstract base class for Master and Worker classes.
 *
 * Contains common logic, mostly config and options parsing.
 * Each implementation should override two methods:
 *  - _getConfigUpdateAction - returns a config-updating promise
 *  - _start - runs the service
 *
 * @constructor
 */
function BaseService(options) {
    if (this.constructor.name === 'BaseService') {
        throw new Error('BaseService is abstract. Create Master or Worker instance.');
    }

    this.options = this._getOptions(options);

    this._logger = null;
    this._metrics = null;
    this.serviceReturns = null;
}

BaseService.prototype._setAppBasePath = function(config) {
    if (process.env.APP_BASE_PATH) {
        this._basePath = process.env.APP_BASE_PATH;
    } else if (config.app_base_path) {
        this._basePath = config.app_base_path;
    } else {
        // Default to guessing the base path
        this._basePath = /\/node_modules\/service-runner\/lib$/.test(__dirname) ?
            path.resolve(__dirname + '/../../../') : path.resolve('./');
    }
};

BaseService.prototype.start = function start(conf) {
    var self = this;
    return self._getConfigUpdateAction(conf)
    .then(function() {
        var config = self.config;
        // display the version
        if (self.options.displayVersion) {
            console.log(config.serviceName + ' ' + config.package.version);
            process.exit(0);
        }

        // do we need to use Docker instead of starting normally ?
        if (self.options.useDocker) {
            self.options.basePath = self._basePath;
            return docker(self.options, self.config);
        }

        self._logger = new Logger(config.logging);

        return self._start();
    });
};

BaseService.prototype._getOptions = function(opts) {

    if (opts) {
        // no need to parse command-line args,
        // opts are already here
        return opts;
    }

    // check process arguments
    var args = require('yargs')
    .usage('Usage: $0 [command] [options]')
    .options({
        n: {
            alias: 'num-workers',
            default: -1,
            describe: 'number of workers to start',
            nargs: 1,
            global: true
        },
        c: {
            alias: 'config',
            default: './config.yaml',
            describe: 'YAML-formatted configuration file',
            type: 'string',
            nargs: 1,
            global: true
        },
        verbose: {
            default: false,
            describe: 'be verbose',
            type: 'boolean',
            global: true
        },
        v: {
            alias: 'version',
            default: false,
            describe: 'print the service\'s version and exit',
            type: 'boolean',
            global: true
        }
    })
    .command('docker-start', 'starts the service in a Docker container')
    .command('docker-test', 'starts the test process in a Docker container')
    .command('build', 'builds the service\'s package and deploy repo', function(yargs) {
        return yargs.option({
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
            s: {
                alias: 'reshrinkwrap',
                default: false,
                describe: 'rebuild shrinkwrap.json by removing and regenerating after npm install',
                type: 'boolean'
            },
            r: {
                alias: 'review',
                default: false,
                describe: 'send the patch to Gerrit after building the repo',
                type: 'boolean'
            }
        });
    })
    .help('h')
    .alias('h', 'help')
    .argv;

    args.deployRepo = args.deployRepo || args.review;
    args.build = args._.indexOf('build') !== -1 || args.deployRepo;
    args.dockerStart = args._.indexOf('docker-start') !== -1;
    args.dockerTest = args._.indexOf('docker-test') !== -1;
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
        reshrinkwrap: args.reshrinkwrap,
        sendReview: args.review,
        dockerStart: args.dockerStart,
        dockerTest: args.dockerTest,
        useDocker: args.deployRepo || args.dockerStart || args.dockerTest,
        force: args.force,
        verbose: args.verbose
    };

    return opts;
};

BaseService.prototype._sanitizeConfig = function(conf, options) {
    // TODO: Perform proper validation!
    if (!conf.logging) { conf.logging = {}; }
    if (!conf.metrics) { conf.metrics = {}; }
    // check the number of workers to run
    if (options.num_workers !== -1) {
        // the number of workers has been supplied
        // on the command line, so honour that
        conf.num_workers = options.num_workers;
    }
    if (typeof conf.num_workers !== 'number') {
        if (/^(?:(?:ncpu[\s\)\+\-\*\/])|[\s\(\)\+\-\*\/\.\d])+(?:ncpu)?$/.test(conf.num_workers)) {
            // It's safe to make an eval here, the input format is checked
            /* jshint evil:true */
            var num = eval(conf.num_workers.replace(/ncpu/g, os.cpus().length));
            conf.num_workers = Math.floor(num);
        } else {
            // use the number of CPUs
            conf.num_workers = os.cpus().length;
        }
    }
    conf.worker_heartbeat_timeout = conf.worker_heartbeat_timeout || 7500;
    return conf;
};


BaseService.prototype._replaceEnvVars = function(config) {
    var envRegex = /\{\s*env\(([^,\s\)]+),?\s*([^\)]+)?\)\s*}/g;
    if (Buffer.isBuffer(config)) {
        config = config.toString();
    }
    return config.replace(envRegex, function(match, envName, defValue) {
        if (process.env[envName] !== undefined) {
            return process.env[envName];
        }
        if (defValue !== undefined) {
            return defValue;
        }
        return '';
    });
};


/**
 * Loads the config from file, serialized input or Object
 *
 * @param conf a configuration.
 *             If undefined - config is loaded from config.yaml file
 *             If Object - treated as already parsed configuration
 *             If sting - treated a serialized yaml config
 * @private
 */
BaseService.prototype._loadConfig = function _loadConfig(conf) {
    var self = this;
    var action;
    if (conf && conf instanceof Object) {
        // Ready config object, no need to load from FS or parse yaml
        action = P.resolve(conf);
    } else if (conf && typeof conf === 'string') {
        // Yaml source provided as config string
        action = P.try(function() {
            return yaml.load(self._replaceEnvVars(conf));
        });
    } else {
        // No config provided - load from file and parse yaml.
        var configFile = this.options.configFile;
        if (!/^\//.test(configFile)) {
            // resolve relative paths
            configFile = path.resolve(process.cwd() + '/' + configFile);
        }
        action = fs.readFileAsync(configFile)
        .then(function(yamlSource) {
            return yaml.load(self._replaceEnvVars(yamlSource));
        });
    }

    return action.then(function(config) {
        self._setAppBasePath(config);

        var packageJson = {};
        try {
            packageJson = require(self._basePath + '/' + 'package.json');
        } catch (e) {}

        config = self._sanitizeConfig(config, self.options);
        config.package = packageJson;
        if (config.info) {
            // for backwards compat
            var pack = config.package;
            pack.name = config.info.name || pack.name;
            pack.description = config.info.description || pack.description;
            pack.version = config.version || pack.version;
        }
        self.config = config;
    })
    .catch(function(e) {
        console.error('Error while reading config file: ' + e);
        process.exit(1);
    });
};

/**
 * Updates the config and sets instance properties.
 *
 * @param conf a configuration.
 *             If undefined - config is loaded from config.yaml file
 *             If Object - treated as already parsed configuration
 *             If sting - treated a serialized yaml config
 * @protected
 */
BaseService.prototype._updateConfig = function _updateConfig(conf) {
    var self = this;

    return self._loadConfig(conf)
    .then(function() {
        var config = self.config;
        var name = config.package && config.package.name || 'service-runner';
        config.serviceName = name;

        // Set up the logger
        if (!config.logging.name) {
            config.logging.name = name;
        }

        // And the statsd client
        if (!config.metrics.name) {
            config.metrics.name = name;
        }
    });
};

BaseService.prototype._requireModule = function(modName) {
    var self = this;
    var opts = arguments[1] || { mod: modName, baseTried: false, modsTried: false };
    try {
        return P.resolve(require(modName));
    } catch (e) {
        if (/^\//.test(opts.mod) || (opts.baseTried && opts.modsTried) ||
                e.message !== "Cannot find module '" + modName + "'") {
            // we have a full path here which can't be required, we have tried
            // all of the possible combinations, or the error is not about not
            // finding modName, so bail out
            e.moduleName = opts.mod;
            return P.reject(e);
        } else {
            // This might be a relative path, convert it to absolute and try again
            if (!opts.baseTried) {
                // first, try to load it from the app's base path
                opts.baseTried = true;
                modName = path.join(self._basePath, opts.mod);
            } else {
                // then, retry its node_modules directory
                opts.modsTried = true;
                modName = path.join(self._basePath, 'node_modules', opts.mod);
            }
            return self._requireModule(modName, opts);
        }
    }
};

module.exports = BaseService;
