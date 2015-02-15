# supervisoid
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
num_workers: 1

# Logger info
logging:
  level: info
  streams:
  # Use gelf-stream -> logstash
  - type: gelf
    host: <%= @logstash_host %>
    port: <%= @logstash_port %>

# Statsd metrics reporter
metrics:
  statsdHost: localhost:8125

services:
  - name: someService
    module: ./lib/server.js
    port: 12345
    interface: localhost
    # more per-service config settings
```

# See also
- https://github.com/strongloop/strong-agent
- http://krakenjs.com/ - Focused more on MVC & templating rather than
    supervision & modules
