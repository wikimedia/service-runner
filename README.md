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

- config loading: standardize on yaml configs (`config.yaml` and
    `config.example.yaml`) with a few standard top-level values (`port`,
    `interface`, `num_workers`)
- logging using bunyan & gelf
- metric reporting using txstatsd
- heap dumps
