
var cluster = require('cluster');
var server = require('http').createServer(function(req, res) {
    res.end('worker: ' + cluster.worker.id);
});

module.exports = function(opts) {
    opts.listen(server);
};