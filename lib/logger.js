'use strict';
var P = require('bluebird');
var extend = require('extend');
var bunyan = require('bunyan');
var gelfStream = require('gelf-stream');
var syslogStream = require('bunyan-syslog-udp');


var DEF_LEVEL = 'warn';
var LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
var DEF_LEVEL_INDEX = LEVELS.indexOf(DEF_LEVEL);


// Simple bunyan logger wrapper
function Logger(confOrLogger, args) {
    var self = this;
    if (confOrLogger.constructor !== Logger) {
        // Create a new root logger
        var conf = this._processConf(confOrLogger);
        self._log_components = conf.log_components || {};
        delete conf.log_components;
        self._logger = bunyan.createLogger(conf);
        self._levelMatcher = this._levelToMatcher(conf.level);

        // For each specially logged component we need to create
        // a child logger that accepts everything regardless of the level
        self._componentLoggers = {};
        Object.keys(self._log_components).forEach(function(component) {
            self._log_components[component] =
                Math.ceil(self._log_components[component] * 1024);
            self._componentLoggers[component] = self._logger.child({
                component: component,
                level: bunyan.TRACE
            });
        });

        // Set up handlers for uncaught extensions
        self._setupRootHandlers();
    } else {
        self._log_components = confOrLogger._log_components;
        self._logger = confOrLogger._logger;
        self._levelMatcher = confOrLogger._levelMatcher;
        self._componentLoggers = confOrLogger._componentLoggers;
    }
    this.args = args;
}

var streamConverter = {
    gelf: function(stream, conf) {
        // Convert the 'gelf' logger type to a real logger
        return {
            type: 'raw',
            stream: gelfStream.forBunyan(stream.host,
                stream.port, stream.options),
            level: stream.level || conf.level
        };
    },
    stdout: function(stream, conf) {
        return {
            stream: process.stdout,
            level: stream.level || conf.level
        };
    },
    stderr: function(stream, conf) {
        return {
            stream: process.stderr,
            level: stream.level || conf.level
        };
    },
    syslog: function(stream, conf) {
        return {
            level: stream.level || conf.level,
            type: 'raw',
            stream: syslogStream.createBunyanStream({
                facility: stream.facility || 'local0',
                host: stream.host || '127.0.0.1',
                port: stream.port || 514
            })
        };
    }
};
var streamConverterList = Object.keys(streamConverter);

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
 * @param {String} level a logging level
 * @returns {Object|undefined} corresponding bunyan log level and a specialized logger
 * @private
 */
Logger.prototype._getComponentLogConfig = function(level) {
    if (level && Object.keys(this._log_components).length) {
        var slashIndex = level.indexOf('/');
        if (slashIndex > 0) {
            var component = level.substr(slashIndex + 1);
            var logProbability = this._log_components[component];
            if (logProbability && Math.ceil(Math.random() * 1024) < logProbability) {
                return {
                    level: level.substring(0, slashIndex),
                    logger: this._componentLoggers[component]
                };
            }
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


Logger.prototype._log = function(info, level, logger) {
    if (info instanceof String) {
        // Need to convert to primitive
        info = info.toString();
    }

    if (typeof info === 'string') {
        logger[level].call(logger, info);
    } else if (typeof info === 'object') {
        // Got an object.
        //
        // We don't want to use bunyan's default error handling, as that
        // drops most attributes on the floor. Instead, make sure we have
        // a msg, and pass that separately to bunyan.
        var msg = this._createMessage(info);

        // Inject the detailed levelpath.
        // 'level' is already used for the numeric level.
        info.levelPath = level;

        // Also pass in default parameters
        info = extend(info, this.args);
        logger[level].call(logger, info, msg);
    }
};

Logger.prototype.log = function(level, info) {
    if (!info) {
        return;
    }

    var simpleLevel = this._getSimpleLogLevel(level);
    if (simpleLevel) {
        this._log(info, simpleLevel, this._logger);
    } else {
        var componentLoggerConf = this._getComponentLogConfig(level);
        if (componentLoggerConf) {
            this._log(info, componentLoggerConf.level, componentLoggerConf.logger);
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