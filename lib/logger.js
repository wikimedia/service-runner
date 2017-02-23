'use strict';
var P = require('bluebird');
var extend = require('extend');
var bunyan = require('bunyan');
var gelfStream = require('gelf-stream');
var syslogStream = require('bunyan-syslog-udp');

var DEF_LEVEL = 'warn';
var LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
var DEF_LEVEL_INDEX = LEVELS.indexOf(DEF_LEVEL);

function extractSimpleLevel(levelPath) {
    return typeof levelPath === 'string' && levelPath.split('/')[0];
}

// Simple bunyan logger wrapper
function Logger(confOrLogger, args) {
    var self = this;
    if (confOrLogger.constructor !== Logger) {
        // Create a new root logger
        var conf = this._processConf(confOrLogger);
        self._sampled_levels = conf.sampled_levels || {};
        delete conf.sampled_levels;
        self._logger = bunyan.createLogger(conf);
        self._addErrorHandler();
        self._levelMatcher = this._levelToMatcher(conf.level);
        // For each specially logged component we need to create
        // a child logger that accepts everything regardless of the level
        self._componentLoggers = {};
        Object.keys(self._sampled_levels).forEach(function(component) {
            self._componentLoggers[component] = self._logger.child({
                component: component,
                level: bunyan.TRACE
            });
        });

        self._traceLogger = self._logger.child({
            level: bunyan.TRACE
        });
        // Set up handlers for uncaught extensions
        self._setupRootHandlers();
    } else {
        self._sampled_levels = confOrLogger._sampled_levels;
        self._logger = confOrLogger._logger;
        self._levelMatcher = confOrLogger._levelMatcher;
        self._componentLoggers = confOrLogger._componentLoggers;
        self._traceLogger = confOrLogger._traceLogger;
    }
    this.args = args;
}

var streamConverter = {
    gelf: function(stream, conf) {
        var host = stream.host;
        var port = stream.port;
        if (stream.uris) {
            var hosts = stream.uris.split(',');
            var selectedURI = hosts[Math.floor(Math.random() * hosts.length)];
            var selectedHost = selectedURI.substr(0, selectedURI.indexOf(':'));
            var selectedPort = parseInt(selectedHost.substr(selectedHost.indexOf(':') + 1));

            if (selectedHost && !Number.isNaN(selectedPort)) {
                host = selectedHost;
                port = selectedPort;
            }
        }

        var impl = gelfStream.forBunyan(host, port, stream.options);

        impl.on('error', function() {
            // Ignore, can't do anything, let's hope other streams will succeed
        });
        // Convert the 'gelf' logger type to a real logger
        return {
            type: 'raw',
            stream: impl,
            level: stream.level || conf.level
        };
    },
    stdout: function(stream, conf) {
        return {
            stream: process.stdout,
            level: stream.level || conf.level
        };
    },
    debug: function(stream, conf) {
        try {
            var PrettyStream = require('bunyan-prettystream');
            var prettyStream = new PrettyStream();
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
    stderr: function(stream, conf) {
        return {
            stream: process.stderr,
            level: stream.level || conf.level
        };
    },
    syslog: function(stream, conf) {
        var impl = syslogStream.createBunyanStream({
            facility: stream.facility || 'local0',
            host: stream.host || '127.0.0.1',
            port: stream.port || 514
        });
        impl.on('error', function() {
            // Ignore, can't do anything, let's hope other streams will succeed
        });
        return {
            level: stream.level || conf.level,
            type: 'raw',
            stream: impl
        };
    }
};
var streamConverterList = Object.keys(streamConverter);

Logger.prototype._addErrorHandler = function() {
    var self = this;
    self._logger.on('error', function(err, failedStream) {
        // If some fatal error occurred in one of the logger streams,
        // we can't do much, so ignore.

        if (failedStream.type === 'file') {
            // However, if it's a `file` stream, it's likely that
            // we're in some catastrophic state. Remove the stream,
            // log the error and hope other streams would deliver it.
            // Attempting to continue logging through a failed `file`
            // stream might end up in a memory leak.
            self._logger.streams = self._logger.streams.filter(function(s) {
                return s !== failedStream;
            });
            failedStream.stream.destroy();
            // Hope that we have other streams to report the problem
            self.log('fatal/service-runner/logger', {
                message: 'Failed to write logs to file',
                error: err
            });
        }
    });
};

Logger.prototype._processConf = function(conf) {
    var self = this;
    conf = conf || {};
    conf = extend({}, conf);
    conf.level = conf.level || DEF_LEVEL;
    var minLevelIdx = this._getLevelIndex(conf.level);
    if (Array.isArray(conf.streams)) {
        var streams = [];
        conf.streams.forEach(function(stream) {
            var idx;
            var convertedStream = stream;
            if (streamConverterList.indexOf(stream.type) > -1) {
                convertedStream = streamConverter[stream.type](stream, conf);
            }
            idx = streams.push(convertedStream);
            idx--;
            // check that there is a level field and
            // update the minimum level index
            if (streams[idx].level) {
                var levelIdx = self._getLevelIndex(streams[idx].level);
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
        err: function(err) {
            var bunyanSerializedError = bunyan.stdSerializers.err(err);
            // We don't want to override properties set by bunyan,
            // as they are fine, we just want to add missing properties
            Object.keys(err).forEach(function(errKey) {
                if (bunyanSerializedError[errKey] === undefined) {
                    bunyanSerializedError[errKey] = err[errKey];
                }
            });
            return bunyanSerializedError;
        }
    };

    return conf;
};

Logger.prototype._getLevelIndex = function(level) {
    var idx = LEVELS.indexOf(level);
    return idx !== -1 ? idx : DEF_LEVEL_INDEX;
};

Logger.prototype._setupRootHandlers = function() {
    var self = this;
    // Avoid recursion if there are bugs in the logging code.
    var inLogger = false;

    function logUnhandledException(err) {
        if (!inLogger) {
            inLogger = true;
            self.log('fatal/service-runner/unhandled', err);
            inLogger = false;
        }
    }

    // Catch unhandled rejections & log them. This relies on bluebird.
    process.on("unhandledRejection", logUnhandledException);

    // Similarly, log uncaught exceptions. Also, exit.
    process.on('uncaughtException', function(err) {
        logUnhandledException(err);
        process.exit(1);
    });
};

Logger.prototype._levelToMatcher = function _levelToMatcher(level) {
    var pos = LEVELS.indexOf(level);
    if (pos !== -1) {
        return new RegExp('^(' + LEVELS.slice(pos).join('|') + ')(?=\/|$)');
    } else {
        // Match nothing
        return /^$/;
    }
};

/**
 * Parses the provided logging level for a log component,
 * matches it with the configured specially logged components.
 *
 * If the message should be logged, returns an object with bunyan log level
 * and a specialized logger for the given component, otherwise returns undefined
 *
 * @param {String} levelPath a logging level + component ( e.g. 'warn/component_name' )
 * @returns {Object|undefined} corresponding bunyan log level and a specialized logger
 * @private
 */
Logger.prototype._getComponentLogConfig = function(levelPath) {
    var logProbability = this._sampled_levels[levelPath];
    if (logProbability && Math.random() < logProbability) {
        var simpleLevel = extractSimpleLevel(levelPath);
        if (simpleLevel) {
            return {
                level: simpleLevel,
                logger: this._componentLoggers[levelPath]
            };
        }
    }
    return undefined;
};

/**
 * Parses the provided logging level.
 *
 * If the level is higher than the configured minimal level, returns it,
 * Otherwise returns undefined.
 *
 * @param {String} level a logging level
 * @returns {String|undefined} corresponding bunyan log level
 * @private
 */
Logger.prototype._getSimpleLogLevel = function(level) {
    var levelMatch = this._levelMatcher.exec(level);
    if (levelMatch) {
        return levelMatch[1];
    }
    return undefined;
};

Logger.prototype.child = function(args) {
    var newArgs = extend({}, this.args, args);
    return new Logger(this, newArgs);
};

Logger.prototype._createMessage = function(info) {
    var msg = info.msg || info.message || info.info;
    if (msg) {
        return msg;
    }
    var infoStr = info.toString();
    // Check if we've got some relevant result
    if (infoStr !== '[object Object]') {
        return infoStr;
    }
    return 'Message not supplied';
};


Logger.prototype._log = function(info, level, levelPath, logger) {
    if (info instanceof String) {
        // Need to convert to primitive
        info = info.toString();
    }

    if (typeof info === 'string') {
        logger[level].call(logger, extend({ levelPath: levelPath }, this.args), info);
    } else if (typeof info === 'object') {
        // Got an object.
        //
        // We don't want to use bunyan's default error handling, as that
        // drops most attributes on the floor. Instead, make sure we have
        // a msg, and pass that separately to bunyan.
        var msg = this._createMessage(info);

        // Inject the detailed levelpath.
        // 'level' is already used for the numeric level.
        info.levelPath = levelPath;

        // Also pass in default parameters
        info = extend(info, this.args);
        logger[level].call(logger, info, msg);
    }
};

/**
 * Logs and info object with a specified level
 * @param {string} level Log level and components, for example 'trace/request'
 * @param {Object|Function} info log statement object, or a callback to lazily construct
 *                               the log statement after we've decided that this particular
 *                               level will be matched.
 */
Logger.prototype.log = function(level, info) {
    var simpleLevel;
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
        var componentLoggerConf = this._getComponentLogConfig(level);
        if (componentLoggerConf) {
            this._log(getLog(info), componentLoggerConf.level, level, componentLoggerConf.logger);
        }
    }
};

Logger.prototype.close = function() {
    var self = this;
    self._logger.streams.filter(function(stream) {
        return stream.type === 'file';
    }).forEach(function(stream) {
        stream.stream.end();
    });
};


module.exports = Logger;
