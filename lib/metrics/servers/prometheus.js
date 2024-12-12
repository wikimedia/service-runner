'use strict';
const Prometheus = require( 'prom-client' );
const AggregatorRegistry = new Prometheus.AggregatorRegistry();
const HTTP = require( 'http' );

// Builds up an HTTP endpoint per Prometheus config
class PrometheusServer {
	constructor( config, num_workers ) {
		this.server = HTTP.createServer( ( req, res ) => {
			res.setHeader( 'Content-Type', AggregatorRegistry.contentType );
			if ( num_workers === 0 ) {
				res.end( Prometheus.register.metrics() );
			} else {
				// config should contain the first `metrics` block in service-runner config,
				// that matched `type === 'prometheus'`.
				if ( config !== null && config.collect_default === true ) {
					throw new Error( 'metrics.prometheus.collect_default cannot be enabled in cluster mode' );
				}
				AggregatorRegistry.clusterMetrics( ( err, metrics ) => {
					if ( err ) {
						this._logger.log( 'error/service-runner', err );
					}
					res.end( metrics );
				} );
			}
		} ).listen( config.port );
	}

	close() {
		Prometheus.register.clear();
		this.server.close();
	}
}
module.exports = PrometheusServer;
