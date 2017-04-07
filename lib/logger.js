'use strict';

const extend = require('extend');
const bunyan = require('bunyan');
const gelfStream = require('gelf-stream');
const syslogStream = require('bunyan-syslog-udp');

const DEF_LEVEL = 'warn';
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const DEF_LEVEL_INDEX = LEVELS.indexOf(DEF_LEVEL);

function extractSimpleLevel(levelPath) {
    return typeof levelPath === 'string' && levelPath.split('/')[0];
}

const streamConverter = {
    gelf(stream, conf) {
        let host = stream.host;
        let port = stream.port;
        if (stream.uris) {
            const hosts = stream.uris.split(',');
            const selectedURI = hosts[Math.floor(Math.random() * hosts.length)];
            const selectedHost = selectedURI.substr(0, selectedURI.indexOf(':'));
            const selectedPort = parseInt(selectedHost.substr(selectedHost.indexOf(':') + 1), 10);

            if (selectedHost && !Number.isNaN(selectedPort)) {
                host = selectedHost;
                port = selectedPort;
            }
        }

        const impl = gelfStream.forBunyan(host, port, stream.options);

        impl.on('error', () => {
            // Ignore, can't do anything, let's hope other streams will succeed
        });
        // Convert the 'gelf' logger type to a real logger
        return {
            type: 'raw',
            stream: impl,
            level: stream.level || conf.level
        };
    },
    stdout(stream, conf) {
        return {
            stream: process.stdout,
            level: stream.level || conf.level
        };
    },
    debug(stream, conf) {
        try {
            const PrettyStream = require('bunyan-prettystream');
            const prettyStream = new PrettyStream();
            prettyStream.pipe(process.stdout);
            return {
                stream: prettyStream,
                level: stream.level || conf.level
            };
        } catch (e) {
            console.log('Could not set up pretty logging stream', e);
            return streamConverter.stdout(stream, conf);
        }
    },
    stderr(stream, conf) {
        return {
            stream: process.stderr,
            level: stream.level || conf.level
        };
    },
    syslog(stream, conf) {
        const impl = syslogStream.createBunyanStream({
            facility: stream.facility || 'local0',
            host: stream.host || '127.0.0.1',
            port: stream.port || 514
        });
        impl.on('error', () => {
            // Ignore, can't do anything, let's hope other streams will succeed
        });
        return {
            level: stream.level || conf.level,
            type: 'raw',
            stream: impl
        };
    }
};
const streamConverterList = Object.keys(streamConverter);

// Simple bunyan logger wrapper
class Logger {
    constructor(confOrLogger, args) {
        if (confOrLogger.constructor !== Logger) {
            // Create a new root logger
            const conf = this._processConf(confOrLogger);
            this._sampled_levels = conf.sampled_levels || {};
            delete conf.sampled_levels;
            this._logger = bunyan.createLogger(conf);
            this._addErrorHandler();
            this._levelMatcher = this._levelToMatcher(conf.level);
            // For each specially logged component we need to create
            // a child logger that accepts everything regardless of the level
            this._componentLoggers = {};
            Object.keys(this._sampled_levels).forEach((component) => {
                this._componentLoggers[component] = this._logger.child({
                    component,
                    level: bunyan.TRACE
                });
            });

            this._traceLogger = this._logger.child({
                level: bunyan.TRACE
            });
            // Set up handlers for uncaught extensions
            this._setupRootHandlers();
        } else {
            this._sampled_levels = confOrLogger._sampled_levels;
            this._logger = confOrLogger._logger;
            this._levelMatcher = confOrLogger._levelMatcher;
            this._componentLoggers = confOrLogger._componentLoggers;
            this._traceLogger = confOrLogger._traceLogger;
        }
        this.args = args;
    }

    _addErrorHandler() {
        this._logger.on('error', (err, failedStream) => {
            // If some fatal error occurred in one of the logger streams,
            // we can't do much, so ignore.

            if (failedStream.type === 'file') {
                // However, if it's a `file` stream, it's likely that
                // we're in some catastrophic state. Remove the stream,
                // log the error and hope other streams would deliver it.
                // Attempting to continue logging through a failed `file`
                // stream might end up in a memory leak.
                this._logger.streams = this._logger.streams.filter(s => s !== failedStream);
                failedStream.stream.destroy();
                // Hope that we have other streams to report the problem
                this.log('fatal/service-runner/logger', {
                    message: 'Failed to write logs to file',
                    error: err
                });
            }
        });
    }

    _processConf(conf) {
        conf = conf || {};
        conf = extend({}, conf);
        conf.level = conf.level || DEF_LEVEL;
        let minLevelIdx = this._getLevelIndex(conf.level);
        if (Array.isArray(conf.streams)) {
            const streams = [];
            conf.streams.forEach((stream) => {
                let idx;
                let convertedStream = stream;
                if (streamConverterList.indexOf(stream.type) > -1) {
                    convertedStream = streamConverter[stream.type](stream, conf);
                }
                idx = streams.push(convertedStream);
                idx--;
                // check that there is a level field and
                // update the minimum level index
                if (streams[idx].level) {
                    const levelIdx = this._getLevelIndex(streams[idx].level);
                    if (levelIdx < minLevelIdx) {
                        minLevelIdx = levelIdx;
                    }
                } else {
                    streams[idx].level = conf.level;
                }
            });
            conf.streams = streams;
            conf.level = LEVELS[minLevelIdx];
        }

        // Define custom log message serializers
        conf.serializers = {
            err(err) {
                const bunyanSerializedError = bunyan.stdSerializers.err(err);
                // We don't want to override properties set by bunyan,
                // as they are fine, we just want to add missing properties
                Object.keys(err).forEach((errKey) => {
                    if (bunyanSerializedError[errKey] === undefined) {
                        bunyanSerializedError[errKey] = err[errKey];
                    }
                });
                return bunyanSerializedError;
            }
        };

        return conf;
    }

    _getLevelIndex(level) {
        const idx = LEVELS.indexOf(level);
        return idx !== -1 ? idx : DEF_LEVEL_INDEX;
    }

    _setupRootHandlers() {
        // Avoid recursion if there are bugs in the logging code.
        let inLogger = false;

        const logUnhandledException = (err) => {
            if (!inLogger) {
                inLogger = true;
                this.log('fatal/service-runner/unhandled', err);
                inLogger = false;
            }
        };

        // Catch unhandled rejections & log them. This relies on bluebird.
        process.on("unhandledRejection", logUnhandledException);

        // Similarly, log uncaught exceptions. Also, exit.
        process.on('uncaughtException', (err) => {
            logUnhandledException(err);
            process.exit(1);
        });
    }

    _levelToMatcher(level) {
        const pos = LEVELS.indexOf(level);
        if (pos !== -1) {
            return new RegExp(`^(${LEVELS.slice(pos).join('|')})(?=/|$)`);
        } else {
            // Match nothing
            return /^$/;
        }
    }

    /**
     * Parses the provided logging level for a log component,
     * matches it with the configured specially logged components.
     *
     * If the message should be logged, returns an object with bunyan log level
     * and a specialized logger for the given component, otherwise returns undefined

     * @param {string} levelPath a logging level + component ( e.g. 'warn/component_name' )
     * @return {Object|undefined} corresponding bunyan log level and a specialized logger
     * @private
     */
    _getComponentLogConfig(levelPath) {
        const logProbability = this._sampled_levels[levelPath];
        if (logProbability && Math.random() < logProbability) {
            const simpleLevel = extractSimpleLevel(levelPath);
            if (simpleLevel) {
                return {
                    level: simpleLevel,
                    logger: this._componentLoggers[levelPath]
                };
            }
        }
        return undefined;
    }

    /**
     * Parses the provided logging level.
     *
     * If the level is higher than the configured minimal level, returns it,
     * Otherwise returns undefined.
     * @param {string} level a logging level
     * @return {string|undefined} corresponding bunyan log level
     * @private
     */
    _getSimpleLogLevel(level) {
        const levelMatch = this._levelMatcher.exec(level);
        if (levelMatch) {
            return levelMatch[1];
        }
        return undefined;
    }

    child(args) {
        const newArgs = extend({}, this.args, args);
        return new Logger(this, newArgs);
    }

    _createMessage(info) {
        const msg = info.msg || info.message || info.info;
        if (msg) {
            return msg;
        }
        const infoStr = info.toString();
        // Check if we've got some relevant result
        if (infoStr !== '[object Object]') {
            return infoStr;
        }
        return 'Message not supplied';
    }

    _log(info, level, levelPath, logger) {
        if (info instanceof String) {
            // Need to convert to primitive
            info = info.toString();
        }

        if (typeof info === 'string') {
            const actualLogger = logger[level];
            actualLogger.call(logger, extend({ levelPath }, this.args), info);
        } else if (typeof info === 'object') {
            // Got an object.
            //
            // We don't want to use bunyan's default error handling, as that
            // drops most attributes on the floor. Instead, make sure we have
            // a msg, and pass that separately to bunyan.
            const msg = this._createMessage(info);

            // Inject the detailed levelpath.
            // 'level' is already used for the numeric level.
            info.levelPath = levelPath;

            // Also pass in default parameters
            info = extend(info, this.args);
            const actualLogger = logger[level];
            actualLogger.call(logger, info, msg);
        }
    }

    /**
     * Logs and info object with a specified level
     * @param {string} level Log level and components, for example 'trace/request'
     * @param {Object|Function} info log statement object, or a callback to lazily construct
     *                               the log statement after we've decided that this particular
     *                               level will be matched.
     */
    log(level, info) {
        let simpleLevel;
        if (!level || !info) {
            return;
        }

        function getLog(info) {
            if (typeof info === "function") {
                return info();
            }
            return info;
        }

        if (Logger.logTrace) {
            simpleLevel = extractSimpleLevel(level);
            if (simpleLevel) {
                this._log(getLog(info), simpleLevel, level, this._traceLogger);
            }
            return;
        }

        simpleLevel = this._getSimpleLogLevel(level);
        if (simpleLevel) {
            this._log(getLog(info), simpleLevel, level, this._logger);
        } else {
            const componentLoggerConf = this._getComponentLogConfig(level);
            if (componentLoggerConf) {
                this._log(getLog(info), componentLoggerConf.level,
                    level, componentLoggerConf.logger);
            }
        }
    }

    close() {
        this._logger.streams.filter(stream => stream.type === 'file').forEach((stream) => {
            stream.stream.end();
        });
    }
}

module.exports = Logger;
