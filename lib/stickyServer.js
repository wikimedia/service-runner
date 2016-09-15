"use strict";

var cluster = require('cluster');
var util = require('util');
var net = require('net');
var ip = require('ip');

function Master(workers) {
    net.Server.call(this, {
        pauseOnConnect: true
    }, this.balance);

    this.seed = (Math.random() * 0xffffffff) | 0;
    this.workers = workers;
}
util.inherits(Master, net.Server);

Master.prototype.hash = function hash(ip) {
    var hash = this.seed;
    for (var i = 0; i < ip.length; i++) {
        hash += ip[i];
        hash %= 2147483648;
        hash += (hash << 10);
        hash %= 2147483648;
        hash ^= hash >> 6;
    }

    hash += hash << 3;
    hash %= 2147483648;
    hash ^= hash >> 11;
    hash += hash << 15;
    hash %= 2147483648;
    return hash >>> 0;
};

Master.prototype.balance = function balance(socket) {
    var addr = ip.toBuffer(socket.remoteAddress || '127.0.0.1'); // TODO: X-Client-IP header is what we want actually
    this.workers[this.hash(addr) % Object.keys(this.workers).length + 1].send('sticky:balance', socket);
};

module.exports = Master;
