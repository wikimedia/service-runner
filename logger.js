"use strict";
var extend = require('extend');
var bunyan = require('bunyan');
var gelf_stream = require('gelf-stream');


var levels = ['trace','debug','info','warn','error','fatal'];
function levelToMatcher (level) {
    var pos = levels.indexOf(level);
    if (pos !== -1) {
        return new RegExp('^(' + levels.slice(pos).join('|') + ')(?=\/|$)');
    } else {
        // Match nothing
        return /^$/;
    }
}

// Simple bunyan logger wrapper
function Logger (conf, logger, args) {
    this.conf = conf;
    this.logger = logger || bunyan.createLogger(conf);
    this.level = conf && conf.level || 'warn';
    this.levelMatcher = levelToMatcher(this.level);
    this.args = args;
}



Logger.prototype.log = function (level) {
    var levelMatch = this.levelMatcher.exec(level);
    if (levelMatch) {
        var logger = this.logger;
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

function makeLogger(conf) {
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
    var newLogger = new Logger(conf);
    function bindAndChild (logger) {
        var log = logger.log.bind(logger);
        log.child = function(args) {
            return bindAndChild(new Logger(conf, logger.logger, args));
        };
        return log;
    }
    var res = bindAndChild(newLogger);

    // Avoid recursion if there are bugs in the logging code.
    var inLogger = false;

    function logUnhandledException (err) {
        if (!inLogger) {
            inLogger = true;
            res('error/restbase/unhandled',  err);
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
    return res;
}

// TODO: Use constructor instead?
module.exports = makeLogger;
