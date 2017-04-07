"use strict";

const P = require('bluebird');
const path = require('path');
const yaml = require('js-yaml');
const fs = P.promisifyAll(require('fs'));
const os = require('os');

const Logger = require('./logger');
const docker = require('./docker');

const NUM_CPU_REGEX = /^(?:(?:ncpu[\s)*+-/])|[\s()*+-/.\d])+(?:ncpu)?$/;
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
class BaseService {
    constructor(options) {
        if (this.constructor.name === 'BaseService') {
            throw new Error('BaseService is abstract. Create Master or Worker instance.');
        }

        this.options = this._getOptions(options);

        this._logger = null;
        this._metrics = null;
        this._ratelimiter = null;
        this.serviceReturns = null;
    }

    stop() {
        if (this._ratelimiter) {
            this._ratelimiter.stop();
        }
    }

    _setAppBasePath(config) {
        if (process.env.APP_BASE_PATH) {
            this._basePath = process.env.APP_BASE_PATH;
        } else if (config.app_base_path) {
            this._basePath = config.app_base_path;
        } else if (/\/node_modules\/service-runner\/lib$/.test(__dirname)) {
            // Default to guessing the base path
            this._basePath = path.resolve(`${__dirname}/../../../`);
        } else {
            this._basePath = path.resolve('./');
        }
    }

    _setUpDNSCaching() {
        const cacheConfig = this.config.dns_cache;
        if (cacheConfig === false) {
            return; // Caching disabled.
        }

        require('dnscache')({
            enable: true,
            ttl: cacheConfig && cacheConfig.ttl || 5,
            cachesize: cacheConfig && cacheConfig.size || 100
        });
    }

    _getConfigUpdateAction(conf) {
        throw new Error('_getConfigUpdateAction must be overwritten!');
    }

    start(conf) {
        return this._getConfigUpdateAction(conf)
        .then(() => {
            const config = this.config;

            // display the version
            if (this.options.displayVersion) {
                console.log(`${config.serviceName} ${config.package.version}`);
                process.exit(0);
            }

            // do we need to use Docker instead of starting normally ?
            if (this.options.useDocker) {
                this.options.basePath = this._basePath;
                return docker(this.options, this.config);
            }

            this._logger = new Logger(config.logging);
            this._setUpDNSCaching();

            return this._start();
        });
    }

    _getOptions(opts) {

        if (opts) {
            // no need to parse command-line args,
            // opts are already here
            return opts;
        }

        // check process arguments
        const args = require('yargs')
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
        .command('build', 'builds the service\'s package and deploy repo', {
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
        })
        .command('generate', 'generates the Dockerfile specification for the service', {
            r: {
                alias: 'running',
                default: false,
                describe: 'generate the Dockerfile to start the service',
                type: 'boolean'
            },
            t: {
                alias: 'testing',
                default: false,
                describe: 'generate the Dockerfile to test the service',
                type: 'boolean'
            },
            b: {
                alias: 'building',
                default: false,
                describe: 'generate the Dockerfile to build the deployment repository',
                type: 'boolean'
            },
        })
        .help('h')
        .alias('h', 'help')
        .argv;

        args.deployRepo = args.deployRepo || args.review;
        args.build = args._.indexOf('build') !== -1 || args.deployRepo;
        args.dockerStart = args._.indexOf('docker-start') !== -1;
        args.dockerTest = args._.indexOf('docker-test') !== -1;
        args.generate = args._.indexOf('generate') !== -1;
        args.deployRepo = args.deployRepo || args.build || args.building;

        if ([args.build, args.dockerStart, args.dockerTest, args.generate]
                .filter(x => !!x).length > 1) {
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
            dockerStart: args.dockerStart || args.running,
            dockerTest: args.dockerTest || args.testing,
            generate: args.generate,
            useDocker: args.deployRepo || args.dockerStart || args.dockerTest || args.generate,
            force: args.force,
            verbose: args.verbose
        };

        return opts;
    }

    _sanitizeConfig(conf, options) {
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
            if (NUM_CPU_REGEX.test(conf.num_workers)) {
                // It's safe to make an eval here, the input format is checked
                /* jshint evil:true */
                /* eslint-disable no-eval */
                const num = eval(conf.num_workers.replace(/ncpu/g, os.cpus().length));
                /* eslint-enable no-eval */
                conf.num_workers = Math.floor(num);
            } else {
                // use the number of CPUs
                conf.num_workers = os.cpus().length;
            }
        }
        conf.worker_heartbeat_timeout = conf.worker_heartbeat_timeout || 7500;
        return conf;
    }

    _replaceEnvVars(config) {
        const envRegex = /\{\s*env\(([^,\s)]+),?\s*([^)]+)?\)\s*}/g;
        if (Buffer.isBuffer(config)) {
            config = config.toString();
        }
        return config.replace(envRegex, (match, envName, defValue) => {
            if (process.env[envName] !== undefined) {
                return process.env[envName];
            }
            if (defValue !== undefined) {
                return defValue;
            }
            return '';
        });
    }

    /**
     * Loads the config from file, serialized input or Object
     * @param {undefined|Object|string} conf a configuration.
     *             If undefined - config is loaded from config.yaml file
     *             If Object - treated as already parsed configuration
     *             If sting - treated a serialized yaml config
     * @private
     */
    _loadConfig(conf) {
        let action;
        if (conf && conf instanceof Object) {
            // Ready config object, no need to load from FS or parse yaml
            action = P.resolve(conf);
        } else if (conf && typeof conf === 'string') {
            // Yaml source provided as config string
            action = P.try(() => yaml.load(this._replaceEnvVars(conf)));
        } else {
            // No config provided - load from file and parse yaml.
            let configFile = this.options.configFile;
            if (!/^\//.test(configFile)) {
                // resolve relative paths
                configFile = path.resolve(`${process.cwd()}/${configFile}`);
            }
            action = fs.readFileAsync(configFile)
            .then(yamlSource => yaml.load(this._replaceEnvVars(yamlSource)));
        }

        return action.then((config) => {
            this._setAppBasePath(config);

            let packageJson = {};
            try {
                packageJson = require(`${this._basePath}/package.json`);
            } catch (e) {
                // Ignore error.
            }

            config = this._sanitizeConfig(config, this.options);
            config.package = packageJson;
            if (config.info) {
                // for backwards compat
                const pack = config.package;
                pack.name = config.info.name || pack.name;
                pack.description = config.info.description || pack.description;
                pack.version = config.version || pack.version;
            }
            this.config = config;
        })
        .catch((e) => {
            console.error(`Error while reading config file: ${e}`);
            process.exit(1);
        });
    }

    /**
     * Updates the config and sets instance properties.
     * @param {undefined|Object|string} conf a configuration.
     *             If undefined - config is loaded from config.yaml file
     *             If Object - treated as already parsed configuration
     *             If sting - treated a serialized yaml config
     * @protected
     */
    _updateConfig(conf) {
        return this._loadConfig(conf)
        .then(() => {
            const config = this.config;
            const name = config.package && config.package.name || 'service-runner';
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
    }

    _requireModule(modName) {
        const opts = arguments[1] || { mod: modName, baseTried: false, modsTried: false };
        try {
            return P.resolve(require(modName));
        } catch (e) {
            if (/^\//.test(opts.mod) || (opts.baseTried && opts.modsTried) ||
                    e.message !== `Cannot find module '${modName}'`) {
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
                    modName = path.join(this._basePath, opts.mod);
                } else {
                    // then, retry its node_modules directory
                    opts.modsTried = true;
                    modName = path.join(this._basePath, 'node_modules', opts.mod);
                }
                return this._requireModule(modName, opts);
            }
        }
    }
}

module.exports = BaseService;
