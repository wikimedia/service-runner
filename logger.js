"use strict";
var extend = require('extend');
var bunyan = require('bunyan');
var gelf_stream = require('gelf-stream');


// Simple bunyan logger wrapper
function Logger (confOrLogger, args) {
    if (confOrLogger.constructor !== Logger) {
        // Create a new root logger
        var conf = this._processConf(confOrLogger);
        this._logger = confOrLogger || bunyan.createLogger(conf);
        var level = conf && conf.level || 'warn';
        this._levelMatcher = this.levelToMatcher(this.level);

        // Set up handlers for uncaught extensions
        this._setupRootHandlers();
    } else {
        this._logger = confOrLogger._logger;
        this._levelMatcher = confOrLogger._levelMatcher;
    }
    this.args = args;
}

Logger.prototype._processConf = function(conf) {
    if (Array.isArray(conf.streams)) {
        var streams = [];
        conf.streams.forEach(function(stream) {
            if (stream.type === 'gelf') {
                // Convert the 'gelf' logger type to a real logger
                streams.push({
                    type: 'raw',
                    stream: gelf_stream.forBunyan(stream.host,
                        stream.port, stream.options)
                });
            } else {
                streams.push(stream);
            }
        });
        conf = extend({}, conf);
        conf.streams = streams;
    }
    return conf;
};

Logger.prototype._setupRootHandlers = function() {
    var self = this;
    // Avoid recursion if there are bugs in the logging code.
    var inLogger = false;
    function logUnhandledException (err) {
        if (!inLogger) {
            inLogger = true;
            self.log('fatal/unhandled',  err);
            inLogger = false;
        }
    }

    // Catch unhandled rejections & log them. This relies on bluebird.
    Promise.onPossiblyUnhandledRejection(logUnhandledException);

    // Similarly, log uncaught exceptions. Also, exit.
    process.on('uncaughtException', function(err) {
        logUnhandledException(err);
        process.exit(1);
    });
};

var levels = ['trace','debug','info','warn','error','fatal'];
Logger.prototype._levelToMatcher = function levelToMatcher (level) {
    var pos = levels.indexOf(level);
    if (pos !== -1) {
        return new RegExp('^(' + levels.slice(pos).join('|') + ')(?=\/|$)');
    } else {
        // Match nothing
        return /^$/;
    }
};

Logger.prototype.child = function (args) {
    var newArgs = extend({}, this.args, args);
    return new Logger(this, newArgs);
};

Logger.prototype.log = function (level) {
    var levelMatch = this._levelMatcher.exec(level);
    if (levelMatch) {
        var logger = this._logger;
        var simpleLevel = levelMatch[1];
        var params = Array.prototype.slice.call(arguments, 1);
        if (params.length && params[0] && typeof params[0] === 'object') {
            // Got an object
            //
            // Inject the detailed levelpath.
            // 'level' is already used for the numeric level.
            params[0].levelPath = level;

            // Also pass in default parameters
            params[0] = extend({}, this.args, params[0]);
        }
        logger[simpleLevel].apply(logger, params);
    }
};


module.exports = Logger;
