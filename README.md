# service-runner
Generic nodejs service runner & supervisor

## Features
- Supervise and [cluster](http://nodejs.org/api/cluster.html) node services in a generic manner with a minimal interface:

```javascript
module.exports = function (options) {
    var config = options.config;
    // Logger instance
    var logger = options.logger;
    // Metrics reporter (statsd,log)
    var metrics = options.metrics;

    // Start the app, returning a promise.
    // Return an object with a `close()` function for clean shut-down support.
    // (ex: node's HTTP server instances).
    return startApp(config, logger, metrics);
}
```

- standard command line parameters:
```bash
Usage: service-runner.js [command] [options]

Commands:
  docker-start  starts the service in a Docker container
  docker-test   starts the test process in a Docker container
  build         builds the service's package and deploy repo

Options:
  -n, --num-workers  number of workers to start                    [default: -1]
  -c, --config       YAML-formatted configuration file
                                             [string] [default: "./config.yaml"]
  -f, --force        force the operation to execute   [boolean] [default: false]
  -d, --deploy-repo  build only the deploy repo       [boolean] [default: false]
  -r, --review       send the patch to Gerrit after building the repo
                                                      [boolean] [default: false]
  --verbose          be verbose                       [boolean] [default: false]
  -v, --version      print the service's version and exit
                                                      [boolean] [default: false]
  -h, --help         Show help                                         [boolean]
```
- [config loading](#config-loading)
- flexible logging using bunyan, including logstash support via gelf: `logger.log('info/request', { message: 'foo', uri: req.uri })`
- [metric reporting](#metric-reporting) using statsd, logging, and/or Prometheus. (See lib/metrics/index.js:Metrics.makeMetric())
- heap dumps

## Usage
```bash
npm install --save service-runner
```
### As a binary
In package.json, configure `npm start` to call service-runner:
```javascript
  "scripts": {
    "start": "service-runner"
  }
```
Create a `config.yaml` file following the spec below. Make sure to point the
module parameter to your service's entry point.

Finally, **start your service with `npm start`**. In npm >= 2.0 (node 0.12 or iojs), you can also pass parameters to `service-runner` like this: `npm start -- -c /etc/yourservice/config.yaml`.

### As a library

Service-runner can also be used to run services within an application. This is
useful for node 0.10 support, but can also be used to run services for testing
or other purposes.

Example script for **starting** a service, using commandline options:

```javascript
var ServiceRunner = require('service-runner');
new ServiceRunner().start();
```
It is also possible to skip commandline options, and pass in a config
directly to `ServiceRunner.start()` (see [the config section](#config_loading)
for details on available options). Here is an example demonstrating this, as
well as return values & the `stop()` method:

```javascript
var ServiceRunner = require('service-runner');
var runner = new ServiceRunner();

var startupPromise = runner.start({
    num_workers: 0,
    services: [{
        name: 'parsoid',
        conf: {...}
    }],
    logging: {...},
})
.then(function(startupResults) {
    // startupResults is an array of arrays of objects returned by each
    // service. These objects should be JSON.stringify()-able.
})
.then(function() {
    // To stop a service, call the stop() method
    return runner.stop();
});
```

### Config loading
- Default config locations in a project: `config.yaml` for a customized config,
    and `config.example.yaml` for an example config for a service.
- You can specify the location of the configuration file in two ways: by using
  the `-c`/`--config` command-line option; or by setting the `APP_CONFIG_PATH`
  environment variable. If both are specified, the environment variable takes
  precedence.
 - By default, we assume that your project depends on `service-runner` and
   you follow standard node project layout. However, if a custom layout is used,
   you must override the app base path with either:
     - `APP_BASE_PATH` environment variable
     - `app_base_path` config stanza.
- If the project requires cancellable promises (which are disabled by default)
  you must set the `APP_ENABLE_CANCELLABLE_PROMISES` environment variable to a
  non-empty and truth-y value (like `1` or `true`). For more information about
  cancellable promises please refer to the
  [Bluebird documentation](http://bluebirdjs.com/docs/api/cancellation.html).
- Default top-level config format (**draft**):

```yaml
# Number of worker processes to spawn.
# Set to 0 to run everything in a single process without clustering.
num_workers: ncpu

# Number of workers to start in parallel after the first worker.
# The first worker is always started independently. After it has completed
# its start-up, this number controls the number of workers to start in
# parallel until `num_workers` have been started. Note that setting this
# number to a too high a value might lead to high resource consumption
# (especially of CPU) during the start-up process.
startup_concurrency: 2

# Number of milliseconds to wait for a heartbeat from worker before killing
# and restarting a worker. 'false' means disabling the heartbeat feature. 
worker_heartbeat_timeout: 7500

# Logger info
logging:
  level: info
  # Sets up sample logging for some 'interesting' events.
  # Map keys correspond to the full log level names.
  # Map values specify the probability for such events to be logged
  # regardless of the configured logging level.
  sampled_levels:
    'trace/webrequest': 0.2
  streams:
  - type: stdout # log to stdout
    named_levels: true # emit log level name instead of index. e.g. INFO vs 30
  # Use gelf-stream -> logstash
  - type: gelf
    host: logstash1003.eqiad.wmnet
    port: 12201
    # Alternatively you can provide a comma-separated list of host:port pairs,
    # the server to use will be selected randomly on startup
    # uris: logstash1001.eqiad.wmnet:12201,logstash1003.eqiad.wmnet:12201

# Statsd metrics reporter
metrics:
  - type: statsd
    host: localhost
    port: 8125
    batch: # Metrics batching options. Supported only for `statsd` reporter type
      max_size: 1500 # Max size of the batch buffer (default: 1500)
      max_delay: 1000  # Max delay for an individual metric in milliseconds (default: 1000)

# Prometheus metrics endpoint
  - type: prometheus
    port: 9000

# Rate limiter (enabled by default)
ratelimit:
  type: memory
  # optional: Kademlia backend
  # type: kad
  # seeds:
  #  - 192.0.2.10
  #  - 192.0.2.20

# DNS caching, switched on by default. To disable caching use:
# dns_cache: false
# To specify caching parameters use:
dns_cache:
  ttl: 5 # Time-to-live for cache entries, in seconds. Default: 5
  size: 100 # Optional cache size. Default: 100  

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

In the configuration file itself, you can also use environment variables:

```yaml
field: '{env(ENV_VAR_NAME[,default_value])}'
```

The service's environment will be inspected, and if the value of `ENV_VAR_NAME`
is defined, it will be used in the configuration. Additionally, one can also
supply a default value in case the environment does not contain the sought
value.

All file paths in the config are relative to the application base path.
The base path is an absolute path to the folder where your application
is located (where `package.json` file is located).

We are also working on a [standard
template](https://github.com/wikimedia/service-template-node) for node
services, which will set up this & other things for you.

### Metric reporting

We basically expose the [node-statsd
interface](https://github.com/sivy/node-statsd):

```javascript
// Timing: sends a timing command with the specified milliseconds
options.metrics.timing('response_time', 42);

// Increment: Increments a stat by a value (default is 1)
options.metrics.increment('my_counter');

// Decrement: Decrements a stat by a value (default is -1)
options.metrics.decrement('my_counter');

// Histogram: send data for histogram stat
options.metrics.histogram('my_histogram', 42);

// Gauge: Gauge a stat by a specified amount
options.metrics.gauge('my_gauge', 123.45);

// Set: Counts unique occurrences of a stat (alias of unique)
options.metrics.set('my_unique', 'foobar');
options.metrics.unique('my_unique', 'foobarbaz');

// Incrementing multiple items
options.metrics.increment(['these', 'are', 'different', 'stats']);

// Sampling, this will sample 25% of the time
// the StatsD Daemon will compensate for sampling
options.metrics.increment('my_counter', 1, 0.25);

// Tags, this will add user-defined tags to the data
options.metrics.histogram('my_histogram', 42, ['foo', 'bar']);
```

All metrics are automatically prefixed by the config-provided service name /
graphite hierachy prefix to ensure a consistent graphite metric hierarchy.

# Rate limiting

Service-runner provides an efficient ratelimiter instance backed by
[limitation](https://github.com/gwicke/limitation). All per-request checks are
done in-memory for low latency and minimal overhead.

To enforce a limit:
```javascript
// Sets limit to 10 req/s, returns true if above limit.
var isAboveLimit = options.ratelimiter.isAboveLimit('some_limit_key', 10);
```

Several backends are supported. By default, a simple in-memory backend is
used. For clusters, a [Kademlia DHT](https://en.wikipedia.org/wiki/Kademlia)
based backend is available. Basic Kademlia configuration:

```yaml
ratelimiter:
  type: kademlia
  # Cluster nodes
  seeds:
    # Port 3050 used by default
    - 192.168.88.99
```

Advanced Kademlia options:
```yaml
ratelimiter:
  type: kademlia
  # Cluster nodes
  seeds:
    # Port 3050 used by default
    - 192.168.88.99
    - address: some.host.com
      port: 6030

  # Optional
  # Address / port to listen on
  # Default: localhost:3050, random port fall-back if port used
  listen:
    address: localhost
    port: 3050
  # Counter update / block interval; Default: 10000ms
  interval: 10000
```

# Worker status tracking
At any point of the execution the service can emit a `service_status` message
to update the worker status. Statuses are tracked and reported when the worker
dies or is killed on a timeout, which is useful for debugging failure reasons.

To emit a status update use the following code:
```javascript
process.emit('service_status', {
   type: 'request_processing_begin',
   uri: req.uri.toString(),
   some_other_property: 'some_value'
})
```

Note: The status message could be an arbitrary object, however it must not contain
cyclic references.

## Issue tracking
Please report issues in [the service-runner phabricator
project](https://phabricator.wikimedia.org/tag/service-runner/).

## See also
- https://github.com/Unitech/PM2 - A lot of features. Focus on interactive
    use with commandline tools. Weak on logging (only local log files). Does
    not support node 0.10's cluster module.
- https://github.com/strongloop/strong-agent - commercial license. Focus on
    profiling and monitoring, although a lot of the functionality is now
    available in other libraries.
- http://krakenjs.com/ - Focused more on MVC & templating rather than
    supervision & modules
- https://www.npmjs.com/package/forever-service - Hooks up [forever](https://github.com/foreverjs/forever) with various init systems; could be useful especially on less common platforms that don't have good init systems.
