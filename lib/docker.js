'use strict';

const spawn = require('child_process').spawn;
const yaml = require('js-yaml');
const P = require('bluebird');
const fs = P.promisifyAll(require('fs'));
const path = require('path');
const os = require('os');
const semver = require('semver');

// Info from the package definition
let pkg;
// Info from the service-runner config file
let config;
// Target info
let targets;

// The options used in the script
let opts;
// The image name
let imgName;
// The container's name
let name;

// Holds the curently running process
let child;

class SpawnError extends Error {
    constructor(code, message) {
        super();
        Error.captureStackTrace(this, SpawnError);
        this.name = this.constructor.name;
        this.message = message;
        this.code = code;
    }
}

/**
 * Wraps a child process spawn in a promise which resolves
 * when the child process exists.
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

    let promise = new P((resolve, reject) => {
        const argOpts = options.capture ? undefined : { stdio: 'inherit' };
        let ret = '';
        let err = '';
        if (opts.verbose) {
            console.log(`# RUNNING: ${args.join(' ')}\n  (in ${process.cwd()})`);
        }
        child = spawn('/usr/bin/env', args, argOpts);
        if (options.capture) {
            child.stdout.on('data', (data) => {
                ret += data.toString();
            });
            child.stderr.on('data', (data) => {
                err += data.toString();
            });
        }
        child.on('close', (code) => {
            child = undefined;
            ret = ret.trim();
            if (ret === '') {
                ret = undefined;
            }
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
        promise = promise.catch((err) => {
            if (options.errMessage) {
                console.error(`ERROR: ${options.errMessage.split('\n').join('\nERROR: ')}`);
            }
            let msg = `ERROR: ${args.slice(0, 2).join(' ')} exited with code ${err.code}`;
            if (err.message) {
                msg += ` and message ${err.message}`;
            }
            console.error(msg);
            process.exit(err.code);
        });
    }

    return promise;

}

/**
 * Generates the Dockerfile used to build the image and start the container
 * @return {Promise} the promise which creates the image file
 */
function createDockerFile() {

    const extraPkgs = [
        'nodejs',
        'git',
        'wget',
        'build-essential',
        // In case we'd need to fallback-to-build for some of the binary dependencies
        // and use node-gyp, we'd need python, so let's install it just in case.
        'python'
   ];
    const nodeVersion = pkg.deploy.node;

    if (nodeVersion === 'system') {
        // In case we're setting a specific node version we use nvm to install npm so we don't
        // need to install npm through the apt-get
        extraPkgs.push('npm');
    }
    // An array where we store custom-sourced extra packages
    // Each element has 'repo_url', 'release', 'pool' and 'packages' properties
    // 'packages' is an array of package names
    // 'repo_url' and 'pool' combinations are unique
    const customSourcePkgs = [];
    // An array of URIs of custom .deb packages to be installed
    const debPkgs = [];

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
    if (!pkg.deploy.node) {
        pkg.deploy.node = 'system';
    }

    const npmVersion = pkg.deploy.npm;
    // set the deploy target
    // allow the user to specify the exact target to use, like "debian:sid"
    const baseImg = /^.+:.+$/.test(pkg.deploy.target) ? pkg.deploy.target : targets[pkg.deploy.target];
    let contents = `FROM ${baseImg}\n`;

    if (!baseImg || baseImg === '') {
        console.error('ERROR: You must specify a valid target!');
        console.error('ERROR: Check the deploy stanza in package.json and targets.yaml');
        process.exit(2);
    }

    // get any additional packages that need to be installed
    Object.keys(pkg.deploy.dependencies).forEach((sys) => {
        if (sys === '_all' || (sys === baseImg || (new RegExp(sys)).test(baseImg))) {
            pkg.deploy.dependencies[sys].forEach((pkg) => {
                if (typeof pkg === 'string') {
                    extraPkgs.push(pkg);
                } else if (typeof pkg === 'object') {
                    if (pkg.uri) {
                        debPkgs.push(pkg.uri);
                    } else if (!pkg.repo_url || !pkg.pool || !pkg.packages || !pkg.release) {
                        console.error(`ERROR: Incorrect dependency spec: ${JSON.stringify(pkg)}`);
                        process.exit(1);
                    } else {
                        customSourcePkgs.push(pkg);
                    }
                } else {
                    console.error(`ERROR: Incorrect dependency spec: ${pkg}`);
                    process.exit(1);
                }
            });
        }
    });

    if (customSourcePkgs.some((customSourcePkgSpec) => /^https/.test(customSourcePkgSpec.repo_url))) {
        extraPkgs.push('apt-transport-https');
    }

    contents += `RUN apt-get update && apt-get install -y ${extraPkgs.join(' ')} && rm -rf /var/lib/apt/lists/*\n`; /**/

    if (customSourcePkgs.length) {
        contents += `RUN echo > /etc/apt/sources.list && ${customSourcePkgs.map((customSourcePkgSpec) =>
            `echo deb "${customSourcePkgSpec.repo_url} ${customSourcePkgSpec.release} ${customSourcePkgSpec.pool}" >> /etc/apt/sources.list`).join(' && ')}\n`;
        contents += `RUN apt-get update && ${customSourcePkgs.map((customSourcePkgSpec) => `apt-get install -y --force-yes -t ${customSourcePkgSpec.release} ${customSourcePkgSpec.packages.join(' ')}`).join(' && ')} && rm -rf /var/lib/apt/lists/*\n`; /**/
    }

    if (debPkgs.length) {
        contents += `RUN ${debPkgs.map((uri) => `wget ${uri} -O package.deb && dpkg -i package.deb && rm package.deb`).join(' && ')}\n`;
    }

    let npmCommand = 'npm';
    if (nodeVersion !== 'system') {
        const nvmDownloadURI = 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.34.0/install.sh';
        contents += 'RUN mkdir -p /usr/local/nvm\n';
        contents += 'ENV NVM_DIR /usr/local/nvm\n';
        contents += `RUN wget -qO- ${nvmDownloadURI} | bash && . $NVM_DIR/nvm.sh && nvm install ${nodeVersion}\n`;
        npmCommand = `. $NVM_DIR/nvm.sh && nvm use ${nodeVersion} && npm`;
    }

    if (!opts.deploy) {
        contents += `RUN mkdir /opt/service\nADD . /opt/service\nWORKDIR /opt/service\nRUN ${npmCommand} install && npm dedupe\n`;
    }

    if (opts.uid !== 0 &&
            // In 'Docker for Mac' the mapping between users/groups
            // is done internally by docker, so we can run as root
            os.type() !== 'Darwin') {
        contents += `RUN groupadd -o -g ${opts.gid} -r rungroup && useradd -o -m -r -g rungroup -u ${opts.uid} runuser\nUSER runuser\nENV HOME=/home/runuser LINK=g++\n`;
    } else {
        contents += 'ENV HOME=/root/ LINK=g++\n';
    }

    let envCommand = 'ENV IN_DOCKER=1';
    if (pkg.deploy.env && Object.keys(pkg.deploy.env)) {
        Object.keys(pkg.deploy.env).forEach((envVar) => {
            envCommand += ` ${envVar}="${pkg.deploy.env[envVar]}"`;
        });
    }
    contents += `${envCommand}\n`;

    if (opts.deploy) {
        let beforeInstall = '';
        let afterInstall = '';
        if (npmVersion) {
            beforeInstall += `${npmCommand} install npm@${npmVersion} &&`;
            npmCommand = './node_modules/.bin/npm';
            afterInstall = '&& rm -rf ./node_modules/npm ./node_modules/.bin/npm';
        }
        let installOpts = ' --production ';
        if (pkg.deploy.install_opts) {
            installOpts += `${pkg.deploy.install_opts.join(' ')} `;
        }
        contents += `CMD ${beforeInstall} ${npmCommand} install${installOpts} ${afterInstall}`;
    } else if (opts.tests) {
        contents += `CMD ${npmCommand} test`;
    } else if (opts.coverage) {
        contents += `CMD ${npmCommand} run-script coverage`;
    } else {
        contents += `CMD ${npmCommand} start`;
    }

    return fs.writeFileAsync('Dockerfile', contents);

}

/**
 * Spawns a docker process which (re)builds the image
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
 * @param {Array} args the array of extra parameters to pass, optional
 * @param {boolean} hidePorts whether to keep the ports hidden inside the container, optional
 * @return {Promise} the promise starting the container
 */
function startContainer(args, hidePorts) {

    const cmd = ['docker', 'run', '--name', name, '--rm'];

    // add the extra args as well
    if (args && Array.isArray(args)) {
        Array.prototype.push.apply(cmd, args);
    }

    if (!hidePorts) {
        // list all of the ports defined in the config file
        config.services.forEach((srv) => {
            srv.conf = srv.conf || {};
            srv.conf.port = srv.conf.port || 8888;
            cmd.push('-p', `${srv.conf.port}:${srv.conf.port}`);
        });
    }

    // append the image name to create a container from
    cmd.push(imgName);

    // ok, start the container
    return promisedSpawn(cmd, { useErrHandler: true });

}
/**
 * Verify that Docker is installed and that the minimum version is 1.8 (1.12 Mac)
 * or terminate the runner.
 * @return {boolean} true if Docker is installed and > min version
 */
function ensureDockerVersion() {
    if (opts.generate) {
        return P.resolve(true);
    }
    return promisedSpawn(['docker', 'version', '--format', '{{.Server.Version}}'], {
        capture: true
    })
    .then((dockerVersion) => {
        if (!dockerVersion) {
            console.error('Docker is not found.');
            process.exit(1);
        }

        const minimumDockerVersion = os.type() === 'Darwin' ? '1.12.0' : '1.8.0';
        dockerVersion = dockerVersion.replace(/\.0+(0|[1-9]+)/g, '.$1');
        if (semver.lt(dockerVersion, minimumDockerVersion)) {
            console.error(`Building the deploy repo on ${os.type()} supported only with docker ${minimumDockerVersion}+`);
            process.exit(1);
        }
    });
}
/**
 * Updates the deploy repository to current master and
 * rebuilds the node modules, committing and git-review-ing
 * the result
 * @return {Promise}
 */
function updateDeploy() {

    function promisedGit(args, options) {
        const argsArr = ['git'];
        Array.prototype.push.apply(argsArr, args);
        options = options || {};
        options.capture = options.capture === undefined ? true : options.capture;
        options.useErrHandler = options.useErrHandler === undefined ? true : options.useErrHandler;
        return promisedSpawn(argsArr, options);
    }

    function chainedPgit(args, options) {
        const arg = args.shift();
        if (!arg) {
            return P.resolve();
        }
        return promisedGit(arg, options)
        .then((data) => {
            if (args.length === 0) {
                return P.resolve(data);
            }
            return chainedPgit(args, options);
        });
    }

    // check if there is an alternative repo name defined
    return P.props({
        name: promisedGit(['config', 'deploy.name'], { ignoreErr: true }),
        remote: promisedGit(['config', 'deploy.remote'], { ignoreErr: true }),
        submodule_ref: promisedGit(['config', 'deploy.submodule'], { ignoreErr: true }),
        deploy_branch: promisedGit(['config', 'deploy.deploybranch'], { ignoreErr: true }),
        src_branch: promisedGit(['config', 'deploy.srcbranch'], { ignoreErr: true })
    }).then((props) => {
        opts.name = props.name || pkg.name;
        opts.remote_name = props.remote || 'origin';
        opts.submodule_ref = props.submodule_ref ||
            `https://gerrit.wikimedia.org/r/mediawiki/services/${opts.name}`;
        opts.src_branch = props.src_branch || 'master';
        opts.deploy_branch = props.deploy_branch || 'master';
        opts.remote_branch = `${opts.remote_name}/${opts.deploy_branch}`;
        // we need to CHDIR into the deploy dir for subsequent operations
        process.chdir(opts.dir);
        return chainedPgit([
            // make sure we are on master
            ['checkout', 'master'],
            // fetch all possible updates
            ['fetch', '--all'],
            // work on a topic branch forked off of the target branch
            ['checkout', '-B', 'sync-repo', opts.remote_branch],
            // check if the submodule is present
            ['submodule', 'status']
       ]);
    }).then((list) => {
        if (list) {
            // the submodule is present
            // in submodule the remote is always called 'origin', so ignore opts.
            opts.submodule = list.split(' ')[1];
            // update it fully
            return promisedGit(['submodule', 'update', '--init'])
            .then(() => {
                process.chdir(`${opts.dir}/${opts.submodule}`);
                return chainedPgit([
                    // fetch new commits
                    ['fetch', 'origin'],
                    // inspect what has changed
                    ['diff', '--name-only', `origin/${opts.src_branch}`]
               ]).then((changes) => {
                    if (/package\.json/.test(changes)) {
                        // package.json has changed, so we need
                        // to rebuild the node_modules directory
                        opts.need_build = true;
                    }
                    // get the SHA1 of the latest commit on the src branch
                    return promisedGit(['rev-parse', '--short', `origin/${opts.src_branch}`]);
                }).then((shortSha1) => {
                    opts.commit_msg = `Update ${opts.name} to ${shortSha1}\n\n`;
                    // get a nice list of commits included in the change
                    return promisedGit(['log',
                        `..origin/${opts.src_branch}`,
                        '--oneline',
                        '--no-merges',
                        '--reverse',
                        '--color=never']);
                }).then((logs) => {
                    if (!logs && !opts.need_build) {
                        // no updates have happened, nothing to do here any more but clean up
                        // go back to the root dir
                        process.chdir(opts.dir);
                        // and get back to master
                        return promisedGit(['checkout', 'master'])
                        .then(() => {
                            console.log('The deploy repository is up to date already, exiting.');
                            process.exit(0);
                        });
                    } else if (logs) {
                        logs += '\n';
                    } else if (!logs) {
                        logs = '';
                    }
                    opts.commit_msg += `List of changes:\n${logs}`;
                    return promisedGit(['checkout', `origin/${opts.src_branch}`]);
                }).then(() => {
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
            opts.commit_msg = `Initial import of ${opts.name}`;
            return promisedGit(['submodule',
                'add',
                opts.submodule_ref,
                opts.submodule]);
        }
    }).then(() => // make sure the package.json symlink is in place
        fs.symlinkAsync(`${opts.submodule}/package.json`, 'package.json')
    .catch(() => {}).then(() => promisedGit(['add', 'package.json']))).then(() => {
        if (!opts.need_build) {
            return;
        }
        // update the commit message
        if (!/^initial/i.test(opts.commit_msg)) {
            opts.commit_msg += 'xxxxxxx Update node module dependencies\n';
        }
        // a rebuild is needed, start by removing the existing modules
        return promisedGit(['rm', '-r', 'node_modules'], { ignoreErr: true })
        .then(() => promisedSpawn(['rm', '-rf', 'node_modules'],
            { capture: true, ignoreErr: true }))
        // start the container which builds the modules
        .then(() => startContainer(['-v', `${opts.dir}:/opt/service`, '-w', '/opt/service'], true))
        .then(() => {
            // remove unnecessary files
            let findAttr;
            if (os.type() === 'Darwin') {
                findAttr = [
                    'find',
                    '-E',
                    'node_modules/',
                    '-iregex',
                    '.*\\.git.*|.*\\.md|.*readme|.*licence',
                    '-exec', 'rm', '-rf', '{}', ';'
               ];
            } else {
                findAttr = [
                    'find',
                    'node_modules/',
                    '-regextype',
                    'posix-egrep',
                    '-iregex',
                    '(.*\\.git.*|.*\\.md|.*readme|.*licence)',
                    '-exec', 'rm', '-rf', '{}', ';'
               ];
            }
            return promisedSpawn(findAttr, { capture: true, ignoreErr: true });
        }).then(() => // add the built submodules
            promisedGit(['add', 'node_modules']));
    }).then(() => // commit the changes
        promisedGit(['commit', '-m', opts.commit_msg]))
        .then(() => {
            if (!opts.review) {
                console.log('\n\nChanges are sitting in the sync-repo branch in');
                console.log(`${opts.dir} with the commit:`);
                console.log(opts.commit_msg);
                return;
            }
            return chainedPgit([
                // send them for review
                ['review', '-R', opts.deploy_branch],
                // get back to master
                ['checkout', 'master'],
                // and reset the submodule pointer
                ['submodule', 'update', '--init']
           ], { capture: false }).then(() => {
                console.log('\n\nChanges sent to Gerrit for review!');
            });
        });
}

/**
 * Determines the UID and GID to run under in the container
 * @return {Promise} a promise resolving when the check is done
 */
function getUid() {

    if (opts.deploy) {
        // get the deploy repo location
        return promisedSpawn(
            ['git', 'config', 'deploy.dir'],
            {
                capture: true,
                errMessage: 'You must set the location of the deploy repo!\n' +
                    'Use git config deploy.dir /full/path/to/deploy/dir'
            }
        ).then((dir) => {
            opts.dir = dir;
            // make sure that the dir exists and it is a git repo
            return fs.statAsync(`${dir}/.git`);
        }).then((stat) => {
            opts.uid = stat.uid;
            opts.gid = stat.gid;
        }).catch(() => {
            console.error(`ERROR: The deploy repo dir ${opts.dir} does not exist or is not a git repo!`);
            process.exit(3);
        });
    }

    // get the uid/gid from statting package.json
    return fs.statAsync('package.json')
    .then((stat) => {
        opts.uid = stat.uid;
        opts.gid = stat.gid;
    }).catch(() => {
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
        generate: options.generate,
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
    if (opts.deploy) {
        imgName += '-deploy';
    }
    // the container's name
    name = `${pkg.name}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // trap exit signals
    process.on('SIGINT', sigHandle);
    process.on('SIGTERM', sigHandle);

    // change the dir
    process.chdir(opts.path);

    // start the process
    return ensureDockerVersion()
    .then(getUid)
    .then(createDockerFile)
    .then(() => {
        if (opts.generate) {
            return;
        }
        return buildImg()
        .then(() => {
            if (opts.deploy) {
                return updateDeploy();
            } else {
                return startContainer();
            }
        });
    });
}

module.exports = main;
