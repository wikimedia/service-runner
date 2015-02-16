# servisor
Generic nodejs service supervisor

## Goals
- Supervise and cluster node services in a generic manner with a minimal interface:

```javascript
module.exports = function (options) {
    var config = options.config;
    // Logger instance
    var logger = options.logger;
    // Statsd metrics reporter
    var statsd = options.statsd;

    // Start the app, returning a promise
    return startApp(config, logger, statsd);
}
```

- [config loading](#config_loading)
- logging using bunyan & gelf
- metric reporting using txstatsd
- heap dumps

### Config loading
- Default config locations in a project: `config.yaml` for a customized config,
    and `config.example.yaml` for the defaults.
- Default top-level config format (**draft**):

```yaml
# Info about this config. Used for packaging & other purposes.
info: 
  name: parsoid
  version: 0.4.0
  description: Bidirectional conversion service between MediaWiki wikitext and
        HTML5

# Package settings. Modeled on Debian, but likely to transfer to rpm as well.
packaging:
  depends:
    nodejs: >=0.10.0
  enhances: mediawiki


# Number of worker processes to spawn. 
# Set to 0 to run everything in a single process without clustering.
num_workers: 1

# Logger info
logging:
  level: info
  streams:
  # Use gelf-stream -> logstash
  - type: gelf
    host: logstash1003.eqiad.wmnet
    port: 12201

# Statsd metrics reporter
metrics:
  type: txstatsd
  host: localhost:8125

services:
  - name: parsoid
    # a relative path or the name of an npm package, if different from name
    # module: ./lib/server.js

    # optionally, a version constraint of the npm package
    # version: ^0.4.0
    
    # per-service config
    conf:
        port: 12345
        interface: localhost
        # more per-service config settings
```

# See also
- https://github.com/strongloop/strong-agent
- http://krakenjs.com/ - Focused more on MVC & templating rather than
    supervision & modules
