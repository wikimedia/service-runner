#!/usr/bin/env node


'use strict';

var spawn = require('child_process').spawn;
var yaml = require('js-yaml');
var P = require('bluebird');
var fs = P.promisifyAll(require('fs'));
var path = require('path');
var util = require('util');

// Info from the package definition
var pkg;
// Info from the service-runner config file
var config;
// Target info
var targets;

// The options used in the script
var opts;
// The image name
var imgName;
// The container's name
var name;

// Holds the curently running process
var child;

function SpawnError(code, message) {
    Error.call(this);
    Error.captureStackTrace(this, SpawnError);
    this.name = this.constructor.name;
    this.message = message;
    this.code = code;
}
util.inherits(SpawnError, Error);


/**
 * Wraps a child process spawn in a promise which resolves
 * when the child process exists.
 *
 * @param {Array}   args     the command and its arguments to run (uses /usr/bin/env)
 * @param {Object}  options  various execution options; attributes:
 *   - {Boolean} capture        whether to capture stdout and return its contents
 *   - {Boolean} useErrHandler  whether to use a generic error handler on failure
 *   - {string}  errMessage     additional error message to emit
 *   - {Boolean} ignoreErr      whether to ignore the error code entirely
 * @return {Promise} the promise which is fulfilled once the child exists
 */
function promisedSpawn(args, options) {

    options = options || {};

    var promise = new P(function(resolve, reject) {
        var argOpts = options.capture ? undefined : { stdio: 'inherit' };
        var ret = '';
        var err = '';
        if (opts.verbose) {
            console.log('# RUNNING: ' + args.join(' ') + '\n' +
                '  (in ' + process.cwd() + ')');
        }
        child = spawn('/usr/bin/env', args, argOpts);
        if (options.capture) {
            child.stdout.on('data', function(data) {
                ret += data.toString();
            });
            child.stderr.on('data', function(data) {
                err += data.toString();
            });
        }
        child.on('close', function(code) {
            child = undefined;
            ret = ret.trim();
            if (ret === '') { ret = undefined; }
            if (code) {
                if (options.ignoreErr) {
                    resolve(ret);
                } else {
                    reject(new SpawnError(code, err.trim()));
                }
            } else {
                resolve(ret);
            }
        });
    });

    if (options.useErrHandler || options.errMessage) {
        promise = promise.catch(function(err) {
            if (options.errMessage) {
                console.error('ERROR: ' + options.errMessage.split("\n").join("\nERROR: "));
            }
            var msg = 'ERROR: ' + args.slice(0, 2).join(' ')
                + ' exited with code ' + err.code;
            if (err.message) {
                msg += ' and message ' + err.message;
            }
            console.error(msg);
            process.exit(err.code);
        });
    }

    return promise;

}


/**
 * Generates the Dockerfile used to build the image and start the container
 *
 * @return {Promise} the promise which creates the image file
 */
function createDockerFile() {

    var contents = '';
    var baseImg;
    var extraPkgs = ['nodejs', 'nodejs-legacy', 'npm', 'git', 'wget'];

    // set some defaults
    if (!pkg.deploy) {
        pkg.deploy = {};
    }
    if (!pkg.deploy.target) {
        pkg.deploy.target = 'debian';
    }
    if (!pkg.deploy.dependencies) {
        pkg.deploy.dependencies = {};
    }
    if (!pkg.deploy.dependencies._all) {
        pkg.deploy.dependencies._all = [];
    }

    // set the deploy target
    baseImg = targets[pkg.deploy.target];
    // get any additional packages that need to be installed
    Object.keys(pkg.deploy.dependencies).forEach(function(sys) {
        if (sys !== '_all' && (sys === baseImg || (new RegExp(sys)).test(baseImg))) {
            Array.prototype.push.apply(extraPkgs, pkg.deploy.dependencies[sys]);
        }
    });
    Array.prototype.push.apply(extraPkgs, pkg.deploy.dependencies._all);

    if (!baseImg || baseImg === '') {
        console.error('ERROR: You must specify a valid target!');
        console.error('ERROR: Check the deploy stanza in package.json and targets.yaml');
        process.exit(2);
    }

    contents = 'FROM ' + baseImg + '\n' +
        'RUN apt-get update && apt-get install -y ' + extraPkgs.join(' ') +
        ' && rm -rf /var/lib/apt/lists/*\n';

    var nodeVersion = pkg.deploy.node;
    var npmCommand = 'npm';
    if (nodeVersion && nodeVersion !== 'system') {
        var nvmDownloadURI = 'https://raw.githubusercontent.com/creationix/nvm/v0.31.1/install.sh';
        contents += 'ENV NVM_DIR /usr/local/nvm\n';
        contents += 'RUN wget -qO- ' + nvmDownloadURI + ' | bash' +
                    ' && . $NVM_DIR/nvm.sh' +
                    ' && nvm install ' + nodeVersion + '\n';
        npmCommand = '. $NVM_DIR/nvm.sh && nvm use ' + nodeVersion + ' && npm';
    }

    if (!opts.deploy) {
        contents += 'RUN mkdir /opt/service\n' +
            'ADD . /opt/service\n' +
            'WORKDIR /opt/service\n' +
            'RUN ' + npmCommand + ' install && npm dedupe\n';
    }

    if (opts.uid !== 0) {
        contents += 'RUN groupadd -g ' + opts.gid + ' -r rungroup && ' +
        'useradd -m -r -g rungroup -u ' + opts.uid + ' runuser\n' +
        'USER runuser\n' + 'ENV HOME=/home/runuser LINK=g++\n';
    } else {
        contents += 'ENV HOME=/root/ LINK=g++\n';
    }

    contents += 'ENV IN_DOCKER=1\n';

    if (opts.deploy) {
        contents += 'CMD ' + npmCommand + ' install --production && ' +
            'npm install heapdump && npm dedupe';
    } else if (opts.tests) {
        contents += 'CMD ' + npmCommand + ' test';
    } else if (opts.coverage) {
        contents += 'CMD ' + npmCommand + ' run-script coverage';
    } else {
        contents += 'CMD ' + npmCommand + ' start';
    }

    return fs.writeFileAsync('Dockerfile', contents);

}


/**
 * Spawns a docker process which (re)builds the image
 *
 * @return {Promise} the promise starting the build
 */
function buildImg() {

    return promisedSpawn(
        ['docker', 'build', '-t', imgName, '.'],
        { errMessage: 'Could not build the docker image!' }
    );

}


/**
 * Starts the container and returns once it has finished executing
 *
 * @param {Array} args the array of extra parameters to pass, optional
 * @param {Boolean} hidePorts whether to keep the ports hidden inside the container, optional
 * @return {Promise} the promise starting the container
 */
function startContainer(args, hidePorts) {

    var cmd = ['docker', 'run', '--name', name, '--rm'];

    // add the extra args as well
    if (args && Array.isArray(args)) {
        Array.prototype.push.apply(cmd, args);
    }

    if (!hidePorts) {
        // list all of the ports defined in the config file
        config.services.forEach(function(srv) {
            srv.conf = srv.conf || {};
            srv.conf.port = srv.conf.port || 8888;
            cmd.push('-p', srv.conf.port + ':' + srv.conf.port);
        });
    }

    // append the image name to create a container from
    cmd.push(imgName);

    // ok, start the container
    return promisedSpawn(cmd, { useErrHandler: true });

}


/**
 * Updates the deploy repository to current master and
 * rebuilds the node modules, committing and git-review-ing
 * the result
 */
function updateDeploy() {

    function promisedGit(args, options) {
        var argsArr = ['git'];
        Array.prototype.push.apply(argsArr, args);
        options = options || {};
        options.capture = true;
        options.useErrHandler = true;
        return promisedSpawn(argsArr, options);
    }

    function chainedPgit(args) {
        var arg = args.shift();
        if (!arg) {
            return P.resolve();
        }
        return promisedGit(arg)
        .then(function(data) {
            if (args.length === 0) {
                return P.resolve(data);
            }
            return chainedPgit(args);
        });
    }

    // check if there is an alternative repo name defined
    return P.props({
        name: promisedGit(['config', 'deploy.name'], { ignoreErr: true }),
        remote: promisedGit(['config', 'deploy.remote'], { ignoreErr: true }),
        submodule_ref: promisedGit(['config', 'deploy.submodule'], { ignoreErr: true })
    }).then(function(props) {
        opts.name = props.name || pkg.name;
        opts.remote_name = props.remote || 'origin';
        opts.submodule_ref = props.submodule_ref ||
            'https://gerrit.wikimedia.org/r/mediawiki/services/' + opts.name;
        opts.remote_branch = opts.remote_name + '/master';
        // we need to CHDIR into the deploy dir for subsequent operations
        process.chdir(opts.dir);
        return chainedPgit([
            // make sure we are on master
            ['checkout', 'master'],
            // fetch any possible updates
            ['fetch', opts.remote_name],
            // work on a topic branch
            ['checkout', '-B', 'sync-repo', opts.remote_branch],
            // check if the submodule is present
            ['submodule', 'status']
        ]);
    }).then(function(list) {
        if (list) {
            // the submodule is present
            // in submodule the remote is always called 'origin', so ignore opts.
            opts.submodule = list.split(' ')[1];
            // update it fully
            return promisedGit(['submodule', 'update', '--init'])
            .then(function() {
                process.chdir(opts.dir + '/' + opts.submodule);
                return chainedPgit([
                    // fetch new commits
                    ['fetch', 'origin'],
                    // inspect what has changed
                    ['diff', '--name-only', 'origin/master']
                ]).then(function(changes) {
                    if (/package\.json/.test(changes)) {
                        // package.json has changed, so we need
                        // to rebuild the node_modules directory
                        opts.need_build = true;
                    }
                    // get the SHA1 of the latest commit on master
                    return promisedGit(['rev-parse', '--short', 'origin/master']);
                }).then(function(shortSha1) {
                    opts.commit_msg = 'Update ' + opts.name + ' to ' + shortSha1 + '\n\n';
                    // get a nice list of commits included in the change
                    return promisedGit(['log',
                        '..origin/master',
                        '--oneline',
                        '--no-merges',
                        '--reverse',
                        '--color=never']);
                }).then(function(logs) {
                    if (!logs && !opts.need_build) {
                        // no updates have happened, nothing to do here any more but clean up
                        // go back to the root dir
                        process.chdir(opts.dir);
                        // and get back to master
                        return promisedGit(['checkout', 'master'])
                        .then(function() {
                            console.log('The deploy repository is up to date already, exiting.');
                            process.exit(0);
                        });
                    } else if (logs) {
                        logs += '\n';
                    } else if (!logs) {
                        logs = '';
                    }
                    opts.commit_msg += 'List of changes:\n' + logs;
                    return promisedGit(['checkout', 'origin/master']);
                }).then(function() {
                    // go back to the root dir
                    process.chdir(opts.dir);
                    // add the submodule changes
                    return promisedGit(['add', opts.submodule]);
                });
            });
        } else {
            // no submodule, need to add it
            opts.submodule = 'src';
            opts.need_build = true;
            opts.commit_msg = 'Initial import of ' + opts.name;
            return promisedGit(['submodule',
                'add',
                opts.submodule_ref,
                opts.submodule]);
        }
    }).then(function() {
        // make sure the package.json symlink is in place
        return fs.symlinkAsync(opts.submodule + '/package.json', 'package.json')
        .catch(function() {}).then(function() {
            return promisedGit(['add', 'package.json']);
        });
    }).then(function() {
        if (!opts.need_build) {
            return;
        }
        // update the commit message
        if (!/^initial/i.test(opts.commit_msg)) {
            opts.commit_msg += 'xxxxxxx Update node module dependencies\n';
        }
        // a rebuild is needed, start by removing the existing modules
        return promisedGit(['rm', '-r', 'node_modules'], { ignoreErr: true })
        .then(function() {
            return promisedSpawn(['rm', '-rf', 'node_modules'], { capture: true, ignoreErr: true });
        }).then(function() {
            // start the container which builds the modules
            return startContainer(['-v', opts.dir + ':/opt/service', '-w', '/opt/service'], true);
        }).then(function() {
            // remove unnecessary files
            return promisedSpawn([
                'find',
                'node_modules/',
                '-regextype',
                'posix-egrep',
                '-iregex',
                '(.*\\.git.*|.*\\.md|.*\\.txt|.*readme|.*licence)',
                '-exec', 'rm', '-rf', '{}', ';'
            ], { capture: true, ignoreErr: true });
        }).then(function() {
            // add the built submodules
            return promisedGit(['add', 'node_modules']);
        });
    }).then(function() {
        // commit the changes
        return promisedGit(['commit', '-m', opts.commit_msg]);
    }).then(function() {
        if (!opts.review) {
            console.log('\n\nChanges are sitting in the sync-repo branch in');
            console.log(opts.dir + ' with the commit:');
            console.log(opts.commit_msg);
            return;
        }
        return chainedPgit([
            // send them for review
            ['review', '-R'],
            // get back to master
            ['checkout', 'master']
        ]).then(function() {
            console.log('\n\nChanges sent to Gerrit for review!');
        });
    });

}


/**
 * Determines the UID and GID to run under in the container
 *
 * @return {Promise} a promise resolving when the check is done
 */
function getUid() {

    if (opts.deploy) {
        // get the deploy repo location
        return promisedSpawn(
            ['git', 'config', 'deploy.dir'],
            {
                capture: true,
                errMessage: "You must set the location of the deploy repo!\n" +
                    'Use git config deploy.dir /full/path/to/deploy/dir'
            }
        ).then(function(dir) {
            opts.dir = dir;
            // make sure that the dir exists and it is a git repo
            return fs.statAsync(dir + '/.git');
        }).then(function(stat) {
            opts.uid = stat.uid;
            opts.gid = stat.gid;
        }).catch(function(err) {
            console.error('ERROR: The deploy repo dir '
                + opts.dir + ' does not exist or is not a git repo!');
            process.exit(3);
        });
    }

    // get the uid/gid from statting package.json
    return fs.statAsync('package.json')
    .then(function(stat) {
        opts.uid = stat.uid;
        opts.gid = stat.gid;
    }).catch(function(err) {
        console.error('ERROR: package.json does not exist!');
        process.exit(4);
    });

}


/**
 * Main process signal handler
 */
function sigHandle() {
    if (child) {
        child.kill('SIGINT');
    }
}


function main(options, configuration) {

    opts = {
        tests: options.dockerTest,
        coverage: false,
        deploy: options.buildDeploy,
        verbose: options.verbose,
        need_build: options.buildDeploy && options.force,
        review: options.sendReview,
        path: options.basePath
    };

    // config and package info
    config = configuration;
    if (!config) {
        config = yaml.safeLoad(fs.readFileSync(path.join(opts.path, 'config.yaml')));
    }
    pkg = config.package;
    if (!pkg) {
        pkg = require(path.join(opts.path, 'package.json'));
    }

    // target info
    try {
        targets = yaml.safeLoad(fs.readFileSync(path.join(opts.path, 'targets.yaml')));
    } catch (e) {
        // no such file or wrong format,
        // set the defaults
        targets = {
            debian: 'debian:jessie',
            ubuntu: 'ubuntu:14.04'
        };
    }

    // use the package's name as the image name
    imgName = pkg.name;
    if (opts.deploy) { imgName += '-deploy'; }
    // the container's name
    name = pkg.name + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

    // trap exit signals
    process.on('SIGINT', sigHandle);
    process.on('SIGTERM', sigHandle);

    // change the dir
    process.chdir(opts.path);

    // start the process
    return getUid()
    .then(createDockerFile)
    .then(buildImg)
    .then(function() {
        if (opts.deploy) {
            return updateDeploy();
        } else {
            return startContainer();
        }
    });
}

module.exports = main;

