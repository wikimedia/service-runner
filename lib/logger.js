'use strict';
var P = require('bluebird');
var extend = require('extend');
var bunyan = require('bunyan');
var gelf_stream = require('gelf-stream');


var DEF_LEVEL = 'warn';
var LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
var DEF_LEVEL_INDEX = LEVELS.indexOf(DEF_LEVEL);


// Simple bunyan logger wrapper
function Logger(confOrLogger, args) {
    if (confOrLogger.constructor !== Logger) {
        // Create a new root logger
        var conf = this._processConf(confOrLogger);
        this._logger = bunyan.createLogger(conf);
        this._levelMatcher = this._levelToMatcher(conf.level);

        // Set up handlers for uncaught extensions
        this._setupRootHandlers();
    } else {
        this._logger = confOrLogger._logger;
        this._levelMatcher = confOrLogger._levelMatcher;
    }
    this.args = args;
}

var streamConverter = {
    gelf: function(stream, conf) {
        // Convert the 'gelf' logger type to a real logger
        return {
            type: 'raw',
            stream: gelf_stream.forBunyan(stream.host,
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
};
var streamConverterList = Object.keys(streamConverter);

Logger.prototype._processConf = function(conf) {
    var self = this;
    conf = conf || {};
    conf.level = conf.level || DEF_LEVEL;
    var minLevelIdx = this._getLevelIndex(conf.level);
    if (Array.isArray(conf.streams)) {
        var streams = [];
        conf.streams.forEach(function(stream) {
            var idx;
            var convertedStream = stream;
            if(streamConverterList.indexOf(stream.type) > -1) {
                convertedStream = streamConverter[stream.type](stream, conf);
            }
            idx = streams.push(convertedStream);
            idx--;
            // check that there is a level field and
            // update the minimum level index
            if(streams[idx].level) {
                var levelIdx = self._getLevelIndex(streams[idx].level);
                if(levelIdx < minLevelIdx) {
                    minLevelIdx = levelIdx;
                }
            } else {
                streams[idx].level = conf.level;
            }
        });
        conf = extend({}, conf);
        conf.streams = streams;
        conf.level = LEVELS[minLevelIdx];
    }
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
    P.onPossiblyUnhandledRejection(logUnhandledException);

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

Logger.prototype.child = function(args) {
    var newArgs = extend({}, this.args, args);
    return new Logger(this, newArgs);
};

Logger.prototype.log = function(level, info) {
    var levelMatch = this._levelMatcher.exec(level);
    if (info && levelMatch) {
        var logger = this._logger;
        var simpleLevel = levelMatch[1];

        if (info instanceof String) {
            // Need to convert to primitive
            info = info.toString();
        }

        if (typeof info === 'string') {
            logger[simpleLevel].call(logger, info);
        } else if (typeof info === 'object') {
            var msg;
            // Got an object
            //
            // If there's a wrapped Error - unwrap and send,
            // bunyan will properly handle it
            if (info.err instanceof Error) {
                info = info.err;
            } else if (info.msg || info.message || info.info) {
                msg = info.msg || info.message || info.info
            }

            // Inject the detailed levelpath.
            // 'level' is already used for the numeric level.
            info.levelPath = level;

            // Also pass in default parameters
            info = extend(info, this.args);
            if (msg) {
                logger[simpleLevel].call(logger, info, msg);
            } else {
                logger[simpleLevel].call(logger, info);
            }
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
