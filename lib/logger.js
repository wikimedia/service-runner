'use strict';

const Writable = require( 'stream' ).Writable;
const bunyan = require( 'bunyan' );
const gelfStream = require( 'gelf-stream' );
const syslogStream = require( 'bunyan-syslog-udp' );
const PrettyStream = require( "@ojolabs/bunyan-prettystream" );

const DEF_LEVEL = 'warn';
const LEVELS = [ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' ];
const DEF_LEVEL_INDEX = LEVELS.indexOf( DEF_LEVEL );

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

// Simple bunyan logger wrapper HAHA
class Logger {
	constructor( configOrLogger, args ) {
		if ( configOrLogger.constructor !== Logger ) {
			this._createNewLogger( configOrLogger );
		} else {
			this._logger = configOrLogger._logger;
		}

		this.args = args;
	}

	_createNewLogger( configOrLogger ) {
		// Create a new root logger
		const conf = this._processConf( configOrLogger );
		this._logger = bunyan.createLogger( conf );
		// For each specially logged component we need to create
		// a child logger that accepts everything regardless of the level TODO why?

		this._errorHandler = ( error, failedStream ) => {
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
					error: error
				} );
			}
		};
		this._logger.on( 'error', this._errorHandler );
	}

	_processConf( conf ) { // unsure about this
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

	/**
	 * Parses the provided logging level.
	 *
	 * If the level is higher than the configured minimal level, returns it,
	 * Otherwise returns undefined.
	 *
	 * @param {string} level a logging level
	 * @return {string|undefined} corresponding bunyan log level, i.e. 'trace'
	 * @private
	 */
	_getSimpleLogLevel( level ) {
		const levelMatch = this._levelMatcher.exec( level );
		if ( levelMatch ) {
			return levelMatch[ 1 ];
		}
		return undefined; // TODO is this right? need error handling
	}

	_extractSimpleLevel( levelPath ) {
		return typeof levelPath === 'string' && levelPath.split( '/' )[ 0 ];
	}

	child( args ) {
		const newArgs = Object.assign( {}, this.args, args );
		return new Logger( this, newArgs );
	}

	_log( messageObj, level, logger ) {
		// messageObj must be an object {} by this point...
		// Got an object.
		//
		// We don't want to use bunyan's default error handling, as that
		// drops most attributes on the floor. Instead, make sure we have
		// a message, and pass that separately to bunyan.
		const message = messageObj.message;

		// 'level' is already used for the numeric level.
		const actualLogger = logger[ level ];
		actualLogger.call( logger, messageObj, message ); // TODO what is meant by 'actualLogger'???
	}

	/**
	 * Logs and info object with a specified level
	 *
	 * @param {string} stringLevel Log level, i.e. 'trace/request' or 'warn'
	 * @param {Object} messageObject log object, i.e. { message: 'the sky is falling', }
	 */
	log( stringLevel, messageObject ) {
		let simpleLevel;
		if ( !stringLevel || !messageObject ) {
			return; // TODO add error or smth
		}

		if ( stringLevel.includes( '/' ) ) {
			simpleLevel = this._extractSimpleLevel( stringLevel );
		} else {
			simpleLevel = this._getSimpleLogLevel( stringLevel );
		}

		this._log( messageObject, simpleLevel, this._logger );
	}

	close() { // TODO what does this do.
		if ( this._logger && this._errorHandler && this._logger.removeListener ) {
			this._logger.removeListener( 'error', this._errorHandler );
		}

		this._logger.streams.filter( ( stream ) => stream.type === 'file' ).forEach( ( stream ) => {
			stream.stream.end();
		} );
	}
}

module.exports = Logger;
