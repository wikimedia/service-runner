#!/usr/bin/env node


'use strict';

var spawn = require('child_process').spawn;
var yaml = require('js-yaml');
var P = require('bluebird');
var fs = P.promisifyAll(require('fs'));
var path = require('path');


// Info from the package definition
var pkg;
// Info from the service-runner config file
var config;
// Target info
var targets;

// The options used in the script
var opts;
// The image name
var img_name;
// The container's name
var name;

// Holds the curently running process
var child;


/**
 * Wraps a child process spawn in a promise which resolves
 * when the child process exists.
 *
 * @param {Array} args the command and its arguments to run (uses /usr/bin/env)
 * @param {Boolean} capture whether to capture stdout and return its contents
 * @return {Promise} the promise which is fulfilled once the child exists
 */
function promised_spawn(args, capture) {

    return new P(function(resolve, reject) {
        var options = capture ? undefined : {stdio: 'inherit'};
        var ret = '';
        if (opts.verbose) {
            console.log('# RUNNING: ' + args.join(' ') + '\n' +
                '  (in ' + process.cwd() + ')');
        }
        child = spawn('/usr/bin/env', args, options);
        if (capture) {
            child.stdout.on('data', function(data) {
                ret += data.toString();
            });
        }
        child.on('close', function() {
            child = undefined;
            ret = ret.trim();
            if (ret === '') { ret = undefined; }
            resolve(ret);
        });
    });

}


/**
 * Generates the Dockerfile used to build the image and start the container
 *
 * @return {Promise} the promise which creates the image file
 */
function create_docker_file() {

    var contents = '';
    var base_img;
    var extra_pkgs = ['nodejs', 'nodejs-legacy', 'npm', 'git'];

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
    base_img = targets[pkg.deploy.target];
    // get any additional packages that need to be installed
    Object.keys(pkg.deploy.dependencies).forEach(function(sys) {
        if (sys !== '_all' && (sys === base_img || (new RegExp(sys)).test(base_img))) {
            Array.prototype.push.apply(extra_pkgs, pkg.deploy.dependencies[sys]);
        }
    });
    Array.prototype.push.apply(extra_pkgs, pkg.deploy.dependencies._all);

    if (!base_img || base_img === '') {
        console.error('ERROR: You must specify a valid target!');
        console.error('ERROR: Check the deploy stanza in package.json and targets.yaml');
        process.exit(2);
    }

    contents = 'FROM ' + base_img + '\n' +
        'RUN apt-get update && apt-get install -y ' + extra_pkgs.join(' ') +
        ' && rm -rf /var/lib/apt/lists/*\n';

    if (!opts.deploy) {
        contents += 'RUN mkdir /opt/service\n' +
            'ADD . /opt/service\n' +
            'WORKDIR /opt/service\n' +
            'RUN npm install\n';
    }

    if (opts.uid !== 0) {
        contents += 'RUN groupadd -g ' + opts.gid + ' -r rungroup && ' +
        'useradd -m -r -g rungroup -u ' + opts.uid + ' runuser\n' +
        'USER runuser\n' + 'ENV HOME=/home/runuser LINK=g++\n';
    } else {
        contents += 'ENV HOME=/root/ LINK=g++\n';
    }

    if (opts.deploy) {
        contents += 'CMD /usr/bin/npm install --production && /usr/bin/npm install heapdump';
    } else if (opts.tests) {
        contents += 'CMD ["/usr/bin/npm", "test"]';
    } else if (opts.coverage) {
        contents += 'CMD ["/usr/bin/npm", "run-script", "coverage"]';
    } else {
        contents += 'CMD ["/usr/bin/npm", "start"]';
    }

    return fs.writeFileAsync('Dockerfile', contents);

}


/**
 * Spawns a docker process which (re)builds the image
 *
 * @return {Promise} the promise starting the build
 */
function build_img() {

    return promised_spawn(['docker', 'build', '-t', img_name, '.']);

}


/**
 * Starts the container and returns once it has finished executing
 *
 * @param {Array} args the array of extra parameters to pass, optional
 * @return {Promise} the promise starting the container
 */
function start_container(args) {

    var cmd = ['docker', 'run', '--name', name, '--rm'];

    // add the extra args as well
    if (args && Array.isArray(args)) {
        Array.prototype.push.apply(cmd, args);
    }

    // list all of the ports defined in the config file
    config.services.forEach(function(srv) {
        srv.conf = srv.conf || {};
        srv.conf.port = srv.conf.port || 8888;
        cmd.push('-p', srv.conf.port + ':' + srv.conf.port);
    });

    // append the image name to create a container from
    cmd.push(img_name);

    // ok, start the container
    return promised_spawn(cmd);

}


/**
 * Updates the deploy repository to current master and
 * rebuilds the node modules, committing and git-review-ing
 * the result
 */
function update_deploy() {

    function promised_git(args) {
        var args_arr = ['git'];
        Array.prototype.push.apply(args_arr, args);
        return promised_spawn(args_arr, true);
    }

    function chained_pgit(args) {
        var arg = args.shift();
        if (!arg) {
            return P.resolve();
        }
        return promised_git(arg)
        .then(function(data) {
            if (args.length === 0) {
                return P.resolve(data);
            }
            return chained_pgit(args);
        });
    }

    // check if there is an alternative repo name defined
    return promised_git(['config', 'deploy.name'])
    .then(function(name) {
        opts.name = name ? name : pkg.name;
        // we need to CHDIR into the deploy dir for subsequent operations
        process.chdir(opts.dir);
        return chained_pgit([
            // make sure we are on master
            ['checkout', 'master'],
            // fetch any possible updates
            ['fetch', 'origin'],
            // work on a topic branch
            ['checkout', '-B', 'sync-repo', 'origin/master'],
            // check if the submodule is present
            ['submodule', 'status']
        ]);
    }).then(function(list) {
        if (list) {
            // the submodule is present
            opts.submodule = list.split(' ')[1];
            // update it fully
            return promised_git(['submodule', 'update', '--init'])
            .then(function() {
                process.chdir(opts.dir + '/' + opts.submodule);
                return chained_pgit([
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
                    return promised_git(['rev-parse', '--short', 'origin/master']);
                }).then(function(short_sha1) {
                    opts.commit_msg = 'Update ' + opts.name + ' to ' + short_sha1 + '\n\n';
                    // get a nice list of commits included in the change
                    return promised_git(['log', '..origin/master', '--oneline', '--no-merges', '--reverse', '--color=never']);
                }).then(function(logs) {
                    if (!logs && !opts.need_build) {
                        // no updates have happened, nothing to do here any more but clean up
                        // go back to the root dir
                        process.chdir(opts.dir);
                        // and get back to master
                        return promised_git(['checkout', 'master'])
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
                    return promised_git(['checkout', 'origin/master']);
                }).then(function() {
                    // go back to the root dir
                    process.chdir(opts.dir);
                    // add the submodule changes
                    return promised_git(['add', opts.submodule]);
                });
            });
        } else {
            // no submodule, need to add it
            opts.submodule = 'src';
            opts.need_build = true;
            opts.commit_msg = 'Initial import of ' + opts.name;
            return promised_git(['submodule', 'add', 'https://gerrit.wikimedia.org/r/mediawiki/services/' + opts.name, opts.submodule]);
        }
    }).then(function() {
        // make sure the package.json symlink is in place
        return fs.symlinkAsync(opts.submodule + '/package.json', 'package.json')
        .catch(function() {}).then(function() {
            return promised_git(['add', 'package.json']);
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
        return promised_git(['rm', '-r', 'node_modules'])
        .then(function() {
            return promised_spawn(['rm', '-rf', 'node_modules'], true);
        }).then(function() {
            // start the container which builds the modules
            return start_container(['-v', opts.dir + ':/opt/service', '-w', '/opt/service']);
        }).then(function() {
            // remove unnecessary files
            return promised_spawn([
                'find',
                'node_modules/',
                '-regextype',
                'posix-egrep',
                '-iregex',
                '(.*\\.git.*|.*\\.md|.*\\.txt|.*readme|.*licence)',
                '-exec', 'rm', '-rf', '{}', ';'
            ], true);
        }).then(function() {
            // add the built submodules
            return promised_git(['add', 'node_modules']);
        });
    }).then(function() {
        // commit the changes
        return promised_git(['commit', '-m', opts.commit_msg]);
    }).then(function() {
        if (!opts.review) {
            console.log('\n\nChanges are sitting in the sync-repo branch in');
            console.log(opts.dir + ' with the commit:');
            console.log(opts.commit_msg);
            return;
        }
        return chained_pgit([
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
function get_uid() {

    if (opts.deploy) {
        // get the deploy repo location
        return promised_spawn(['git', 'config', 'deploy.dir'], true)
        .then(function(dir) {
            if (!dir) {
                console.error('ERROR: You must set the location of the deploy repo!');
                console.error('ERROR: Use git config deploy.dir /full/path/to/deploy/dir');
                process.exit(2);
            }
            opts.dir = dir;
            // make sure that the dir exists and it is a git repo
            return fs.statAsync(dir + '/.git');
        }).then(function(stat) {
            opts.uid = stat.uid;
            opts.gid = stat.gid;
        }).catch(function(err) {
            console.error('ERROR: The deploy repo dir ' + opts.dir + ' does not exist or is not a git repo!');
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
function sig_handle() {
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
    img_name = pkg.name;
    if (opts.deploy) { img_name += 'deploy'; }
    // the container's name
    name = pkg.name + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

    // trap exit signals
    process.on('SIGINT', sig_handle);
    process.on('SIGTERM', sig_handle);

    // change the dir
    process.chdir(opts.path);

    // start the process
    return get_uid()
    .then(create_docker_file)
    .then(build_img)
    .then(function() {
        if (opts.deploy) {
            return update_deploy();
        } else {
            return start_container();
        }
    });
}

module.exports = main;

