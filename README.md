# service-runner
Generic nodejs service runner & supervisor

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

- standard command line parameters:
```bash
Usage: node ./service-runner.js [-h|-v] [--param[=val]]

Options:
  -n, --num-workers  [default: -1]
  -c, --config       [default: "./config.yaml"]
  -v, --version      [default: false]
  -h, --help         [default: false]
```
- [config loading](#config-loading)
- flexible logging using bunyan, including logstash support via gelf
- metric reporting using txstatsd
- heap dumps

## Usage
```bash
npm install --save service-runner
```

In package.json, configure `npm start` to call service-runner:
```javascript
  "scripts": {
    "start": "service-runner"
  }
```
Create a `config.yaml` file following the spec below. Make sure to point the
module parameter to your service's entry point.

Finally, **start your service with `npm start`**. In npm >= 2.0 (node 0.12 or iojs), you can also pass parameters to `service-runner` like this: `npm start -- -c /etc/yourservice/config.yaml`.

For node 0.10 support, you can create a small wrapper script like this:
```javascript
var ServiceRunner = require('service-runner');
new ServiceRunner().run();
```

We are also working on a [standard
template](https://github.com/wikimedia/service-template-node) for node
services, which will set up this & other things for you.

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
  host: localhost
  port: 8125

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

# Issue tracking

Please report issues in [the service-runner phabricator
project](https://phabricator.wikimedia.org/tag/service-runner/).

# See also
- https://github.com/Unitech/PM2/ - A lot of features. Focus on interactive
    use with commandline tools. Weak on logging (only local log files). Does
    not support node 0.10's cluster module.
- https://github.com/strongloop/strong-agent - commercial license. Focus on
    profiling and monitoring, although a lot of the functionality is now
    available in other libraries.
- http://krakenjs.com/ - Focused more on MVC & templating rather than
    supervision & modules
