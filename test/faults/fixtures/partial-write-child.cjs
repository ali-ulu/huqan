'use strict';

const fs = require('node:fs');

const filePath = process.argv[2];
if (!filePath) process.exit(2);

const fd = fs.openSync(filePath, 'a', 0o600);
fs.writeSync(fd, '{"receiptId":"partial","status":"executed"');
fs.fsyncSync(fd);
fs.writeSync(1, 'READY\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
