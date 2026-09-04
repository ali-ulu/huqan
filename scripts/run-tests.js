#!/usr/bin/env node
'use strict';

/**
 * Run `node --test` against a throwaway gate state root.
 *
 * Why this exists rather than calling `node --test` from package.json: the
 * suite would otherwise read the operator's live external-action policy and
 * append to their live receipt trail (#1846). scripts/test-state-sandbox.js
 * carries the full reasoning; this file is only the entry point.
 *
 * Usage:  node scripts/run-tests.js [node --test arguments...]
 */

const { spawn } = require('node:child_process');
const { createTestStateSandbox } = require('./test-state-sandbox');

const sandbox = createTestStateSandbox();

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: sandbox.environment,
});

child.on('error', error => {
  sandbox.cleanup();
  process.stderr.write(`could not start the test runner: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  sandbox.cleanup();
  // A signalled child has no exit code; report it as a shell would, so a
  // cancelled run is not mistaken for a passing one.
  process.exit(signal ? 128 : code === null ? 1 : code);
});
