'use strict';

const Writable = require( 'stream' ).Writable;
const bunyan = require( 'bunyan' );
const gelfStream = require( 'gelf-stream' );
const syslogStream = require( 'bunyan-syslog-udp' );

const DEF_LEVEL = 'warn';
const LEVELS = [ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' ];
const DEF_LEVEL_INDEX = LEVELS.indexOf( DEF_LEVEL );

function extractSimpleLevel( levelPath ) {
	return typeof levelPath === 'string' && levelPath.split( '/' )[ 0 ];
}

class NamedLevelStdout extends Writable {
	constructor( downstream, options = {} ) {
		super( Object.assign( options, { objectMode: true } ) );
		this.downstream = downstream;
	}

	_write( logEntry, encoding, callback ) {
		logEntry.level = bunyan.nameFromLevel[ logEntry.level ].toUpperCase();
		this.downstream.write(
			JSON.stringify( logEntry ) + '\n',
			encoding,
			callback
		);
	}

	destroy() {
		super.destroy();
		this.downstream.destroy();
	}
}

const streamConverter = {
	gelf( stream, conf ) {
		let host = stream.host;
		let port = stream.port;
		if ( stream.uris ) {
			const hosts = stream.uris.split( ',' );
			const selectedURI = hosts[ Math.floor( Math.random() * hosts.length ) ];
			const selectedHost = selectedURI.slice( 0, Math.max( 0, selectedURI.indexOf( ':' ) ) );
			const selectedPort = parseInt( selectedHost.slice( selectedHost.indexOf( ':' ) + 1 ), 10 );

			if ( selectedHost && !Number.isNaN( selectedPort ) ) {
				host = selectedHost;
				port = selectedPort;
			}
		}

		const impl = gelfStream.forBunyan( host, port, stream.options );

		impl.on( 'error', () => {
			// Ignore, can't do anything, let's hope other streams will succeed
		} );
		// Convert the 'gelf' logger type to a real logger
		return {
			type: 'raw',
			stream: impl,
			level: stream.level || conf.level
		};
	},
	stdout( stream, conf ) {
		if ( stream.named_levels ) {
			return {
				type: 'raw',
				stream: new NamedLevelStdout( process.stdout ),
				level: stream.level || conf.level
			};
		} else {
			return {
				stream: process.stdout,
				level: stream.level || conf.level
			};
		}
	},
	debug( stream, conf ) {
		try {
			const PrettyStream = require( '@ojolabs/bunyan-prettystream' );
			const prettyStream = new PrettyStream();
			prettyStream.pipe( process.stdout );
			return {
				stream: prettyStream,
				level: stream.level || conf.level
			};
		} catch ( e ) {
			console.log( 'Could not set up pretty logging stream', e );
			return streamConverter.stdout( stream, conf );
		}
	},
	stderr( stream, conf ) {
		return {
			stream: process.stderr,
			level: stream.level || conf.level
		};
	},
	syslog( stream, conf ) {
		const defaultOpts = {
			facility: 'local0',
			host: '127.0.0.1',
			port: 514,
			prefix: '',
			name: 'node'
		};

		const impl = syslogStream.createBunyanStream( Object.assign( defaultOpts, stream ) );
		impl.on( 'error', () => {
			// Ignore, can't do anything, let's hope other streams will succeed
		} );
		return {
			level: stream.level || conf.level,
			type: 'raw',
			stream: impl
		};
	}
};
const streamConverterList = Object.keys( streamConverter );

const severityLevels = {
	10: 'TRACE',
	20: 'DEBUG',
	30: 'INFO',
	40: 'WARN',
	50: 'ERROR',
	60: 'FATAL'
};
// Simple bunyan logger wrapper
class Logger {
	constructor( confOrLogger, args ) {
		if ( confOrLogger.constructor !== Logger ) {
			// TODO when is it NOT already Logger and when is it?
			// seems we get in here with `req.logger.log( 'trace', {...`
			// Create a new root logger
			const conf = this._processConf( confOrLogger );
			this._sampled_levels = conf.sampled_levels || {};
			delete conf.sampled_levels;
			this._logger = bunyan.createLogger( conf );
			this._levelMatcher = this._levelToMatcher( conf.level );
			// For each specially logged component we need to create
			// a child logger that accepts everything regardless of the level TODO why?
			this._componentLoggers = {};
			// TODO does this even get used/work?
			Object.keys( this._sampled_levels ).forEach( ( component ) => {
				const childLogger = this._logger.child( {
					component,
					// TODO why trace and not 'info' if we're not providing stacktrace?
					// TODO and why do we default it to 'trace' and not use the provided level?
					// level: bunyan.TRACE
					// well it seems these are what's causing all the '10's in Logstash?
					level: conf.level || 'INFO' // this gets translated to numeric (but always?)
				} );
				// manually adjust Bunyan-set values to distinguish log level versus its numeric val
				childLogger.numericLevel = component.level;
				childLogger.level = severityLevels[ component.level ];
				this._componentLoggers[ component ] = childLogger;
			} );

			this._traceLogger = this._logger.child( {
				// TODO why trace and not 'info' if we're not providing stacktrace?
				// TODO and why do we default it to 'trace' and not use the provided level?
				// level: bunyan.TRACE
				level: conf.level || 'INFO' // this gets translated to numeric (but always?)
			} );
			// manually adjust Bunyan-set values to distinguish a log level versus its numeric value
			this._traceLogger._levelNumeric = this._traceLogger._level;
			this._traceLogger._level = severityLevels[ this._traceLogger._level ];
			// TODO: streams: [ { ...level: 60 } ] remains numeric; is this ok?

			this._errorHandler = ( err, failedStream ) => {
				// If some fatal error occurred in one of the logger streams,
				// we can't do much, so ignore.

				if ( failedStream.type === 'file' ) {
					// However, if it's a `file` stream, it's likely that
					// we're in some catastrophic state. Remove the stream,
					// log the error and hope other streams would deliver it.
					// Attempting to continue logging through a failed `file`
					// stream might end up in a memory leak.
					this._logger.streams = this._logger.streams.filter(
						( s ) => s !== failedStream
					);
					failedStream.stream.destroy();
					// Hope that we have other streams to report the problem
					this.log( 'fatal/service-runner/logger', {
						message: 'Failed to write logs to file',
						error: err
					} );
				}
			};
			this._logger.on( 'error', this._errorHandler );
		} else {
			this._sampled_levels = confOrLogger._sampled_levels;
			this._logger = confOrLogger._logger;
			this._levelMatcher = confOrLogger._levelMatcher;
			this._componentLoggers = confOrLogger._componentLoggers;
			this._traceLogger = confOrLogger._traceLogger;
		}

		// manually adjust Bunyan-set values to distinguish a log level versus its numeric value
		if ( typeof this._logger._level === 'number' ) {
			this._logger._levelNumeric = this._logger._level;
			this._logger._level = severityLevels[ this._logger._level ];
		}
		this.args = args;
	}

	_processConf( conf ) {
		conf = conf || {};
		conf = Object.assign( {}, conf );
		conf.level = conf.level || DEF_LEVEL; // TODO rename use of 'level' vs idx?
		let minLevelIdx = this._getLevelIndex( conf.level );
		if ( Array.isArray( conf.streams ) ) {
			const streams = [];
			conf.streams.forEach( ( stream ) => {
				let idx;
				let convertedStream = stream;
				if ( streamConverterList.includes( stream.type ) ) {
					convertedStream = streamConverter[ stream.type ]( stream, conf );
				}
				idx = streams.push( convertedStream );
				idx--;
				// check that there is a level field and
				// update the minimum level index
				if ( streams[ idx ].level ) {
					const levelIdx = this._getLevelIndex( streams[ idx ].level );
					if ( levelIdx < minLevelIdx ) {
						minLevelIdx = levelIdx;
					}
				} else {
					streams[ idx ].level = conf.level;
				}
			} );
			conf.streams = streams;
			conf.level = LEVELS[ minLevelIdx ];
		}

		// Define custom log message serializers
		conf.serializers = {
			err( err ) {
				const bunyanSerializedError = bunyan.stdSerializers.err( err );
				// We don't want to override properties set by bunyan,
				// as they are fine, we just want to add missing properties
				Object.keys( err ).forEach( ( errKey ) => {
					if ( bunyanSerializedError[ errKey ] === undefined ) {
						bunyanSerializedError[ errKey ] = err[ errKey ];
					}
				} );
				return bunyanSerializedError;
			}
		};

		return conf;
	}

	_getLevelIndex( level ) {
		const idx = LEVELS.indexOf( level );
		return idx !== -1 ? idx : DEF_LEVEL_INDEX;
	}

	_levelToMatcher( level ) {
		const pos = LEVELS.indexOf( level );
		if ( pos !== -1 ) {
			// eslint-disable-next-line security/detect-non-literal-regexp
			return new RegExp( `^(${ LEVELS.slice( pos ).join( '|' ) })(?=/|$)` );
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
	 *
	 * @param {string} levelPath a logging level + component (e.g. 'warn/component_name')
	 * @return {Object|undefined} corresponding bunyan log level and a specialized logger
	 * @private
	 */
	_getComponentLogConfig( levelPath ) {
		const logProbability = this._sampled_levels[ levelPath ];
		if ( logProbability && Math.random() < logProbability ) {
			const simpleLevel = extractSimpleLevel( levelPath );
			if ( simpleLevel ) {
				return {
					level: simpleLevel,
					logger: this._componentLoggers[ levelPath ]
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
	 *
	 * @param {string} level a logging level
	 * @return {string|undefined} corresponding bunyan log level
	 * @private
	 */
	_getSimpleLogLevel( level ) {
		const levelMatch = this._levelMatcher.exec( level );
		if ( levelMatch ) {
			return levelMatch[ 1 ];
		}
		return undefined;
	}

	child( args ) {
		const newArgs = Object.assign( {}, this.args, args );
		return new Logger( this, newArgs );
	}

	_createMessage( info ) {
		const message = info.message || info.msg || info.info;
		if ( message ) {
			return message;
		}
		const infoStr = info.toString();
		// Check if we've got some relevant result
		if ( infoStr !== '[object Object]' ) {
			return infoStr;
		}
		return 'Message not supplied';
	}

	_log( info, level, levelPath, logger ) {
		if ( info instanceof String ) {
			// Need to convert to primitive
			info = info.toString();
		}

		if ( typeof info === 'string' ) {
			const actualLogger = logger[ level ];
			actualLogger.call( logger, Object.assign( { levelPath }, this.args ), info );
		} else if ( typeof info === 'object' ) {
			// Got an object.
			//
			// We don't want to use bunyan's default error handling, as that
			// drops most attributes on the floor. Instead, make sure we have
			// a message, and pass that separately to bunyan.
			const message = this._createMessage( info );

			// Also pass in default parameters
			if ( info instanceof Error ) {
				const copy = ( err ) => {
					const res = Object.assign( Object.create( Object.getPrototypeOf( err ) ), err );
					res.stack = err.stack;
					return res;
				};

				// We want to preserve the Error type before bunyan serialisation kicks in.
				info = Object.assign( copy( info ), this.args );
			} else {
				info = Object.assign( {}, info, this.args );
			}

			// Inject the detailed levelpath.
			// 'level' is already used for the numeric level.
			info.levelPath = levelPath;
			const actualLogger = logger[ level ];
			actualLogger.call( logger, info, message );
		}
	}

	/**
	 * Logs and info object with a specified level
	 *
	 * @param {string} level Log level and components, for example 'trace/request'
	 * @param {Object|Function} info log statement object, or a callback to lazily construct
	 *                               the log statement after we've decided that this particular
	 *                               level will be matched.
	 */
	log( level, info ) {
		let simpleLevel;
		if ( !level || !info ) {
			return; // TODO add console.log?
		}

		function getLog( info ) {
			if ( typeof info === 'function' ) {
				return info();
			}
			return info;
		}

		if ( Logger.logTrace ) { // TODO what?
			simpleLevel = extractSimpleLevel( level );
			if ( simpleLevel ) {
				this._log( getLog( info ), simpleLevel, level, this._traceLogger );
			}
			return;
		}

		simpleLevel = this._getSimpleLogLevel( level );
		if ( simpleLevel ) {
			this._log( getLog( info ), simpleLevel, level, this._logger );
		} else {
			const componentLoggerConf = this._getComponentLogConfig( level );
			if ( componentLoggerConf ) {
				this._log( getLog( info ), componentLoggerConf.level,
					level, componentLoggerConf.logger );
			}
		}
	}

	close() {
		if ( this._logger && this._errorHandler && this._logger.removeListener ) {
			this._logger.removeListener( 'error', this._errorHandler );
		}

		this._logger.streams.filter( ( stream ) => stream.type === 'file' ).forEach( ( stream ) => {
			stream.stream.end();
		} );
	}
}

module.exports = Logger;
