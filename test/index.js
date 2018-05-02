"use strict";

require('mocha-jshint')();
require('mocha-eslint')(
    ['lib', 'service-runner.js'],
    { timeout: 5000 }
);