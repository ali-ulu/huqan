'use strict';
// Shim: canonical lives in server-timeouts.js to keep server.js FANOUT stable (Gate A #2366).
module.exports = require('./server-timeouts');
