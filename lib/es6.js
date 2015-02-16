"use strict";
var assert = require('assert');

/**
 * Provide a few common es6 features:
 * - Promise: bluebird
 * - Map, Set & WeakMap: es6-collections
 *   es6-shim provides the same functionality, but performs worse than
 *   es6-collections
 * - other bits: es6-shim
 */

var bluebird;


//require('es6-shim');
require('es6-collections');
if (!global.Promise || !global.Promise.each
        || !global.Promise.promisifyAll) {
    global.Promise = require('bluebird');
    bluebird = Promise;
}
