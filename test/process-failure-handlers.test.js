'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

const {
  PROCESS_FAILURE_CODES,
  PROCESS_FAILURE_EVENTS,
  failureCodeFor,
  createProcessFailureHandlers,
} = require('../lib/http/process-failure-handlers');

test('failureCodeFor preserves taxonomy code and falls back deliberately', () => {
  const withCode = { code: 'HUQAN_HTTP_TIMEOUT_INVALID' };
  assert.equal(failureCodeFor('unhandledRejection', withCode), 'HUQAN_HTTP_TIMEOUT_INVALID');
  assert.equal(failureCodeFor('unhandledRejection', {}), PROCESS_FAILURE_CODES.UNHANDLED_REJECTION);
  assert.equal(failureCodeFor('uncaughtException', null), PROCESS_FAILURE_CODES.UNCAUGHT_EXCEPTION);
  assert.equal(PROCESS_FAILURE_EVENTS.unhandledRejection, 'process.unhandled_rejection');
  assert.equal(PROCESS_FAILURE_EVENTS.uncaughtException, 'process.uncaught_exception');
});

test('constructor validates its boundary', () => {
  assert.throws(() => createProcessFailureHandlers({}), { name: 'TypeError' });
  assert.throws(() => createProcessFailureHandlers({ logError: () => {} , target: {} }), { name: 'TypeError' });
});

test('unhandledRejection logs taxonomy and exits non-zero (no swallow)', () => {
  const target = new EventEmitter();
  target.exitCode = 0;
  target.exit = (code) => { target.exitCode = code; };
  const seen = [];
  const handlers = createProcessFailureHandlers({
    target,
    logError: (kind, cause) => { seen.push([kind, cause]); },
    exit: (code) => { target.exit(code); },
  });
  handlers.bind();
  const reason = Object.assign(new Error('boom'), { code: 'E_BOOM' });
  target.emit('unhandledRejection', reason);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'unhandledRejection');
  assert.equal(target.exitCode, 1);
  handlers.uninstall();
});

test('uncaughtException logs and exits even when logging throws', () => {
  const target = new EventEmitter();
  let exited = null;
  const handlers = createProcessFailureHandlers({
    target,
    logError: () => { throw new Error('logger down'); },
    exit: (code) => { exited = code; },
  });
  handlers.bind();
  target.emit('uncaughtException', new Error('fatal'));
  assert.equal(exited, 1);
  handlers.uninstall();
});

test('second failure does not double-exit (guard)', () => {
  const target = new EventEmitter();
  let exits = 0;
  const logs = [];
  const handlers = createProcessFailureHandlers({
    target,
    logError: (kind, cause) => { logs.push(kind); },
    exit: () => { exits += 1; },
  });
  handlers.bind();
  target.emit('unhandledRejection', new Error('first'));
  target.emit('uncaughtException', new Error('second'));
  assert.equal(logs.length, 1);
  assert.equal(exits, 1);
  handlers.uninstall();
});

test('uninstall removes both listeners', () => {
  const target = new EventEmitter();
  const handlers = createProcessFailureHandlers({ target, logError: () => {}, exit: () => {} });
  handlers.bind();
  assert.equal(target.listenerCount('unhandledRejection'), 1);
  assert.equal(target.listenerCount('uncaughtException'), 1);
  handlers.uninstall();
  assert.equal(target.listenerCount('unhandledRejection'), 0);
  assert.equal(target.listenerCount('uncaughtException'), 0);
});

test('child with un-awaited rejection logs taxonomy event and exits 1', async () => {
  const modulePath = path.join(__dirname, '..', 'lib', 'http', 'process-failure-handlers.js').replace(/\\/g, '\\\\');
  const script = [
    `const { createProcessFailureHandlers, failureCodeFor } = require('${modulePath}');`,
    `const { writeStructuredLog } = require('${path.join(__dirname, '..', 'lib', 'http', 'structured-log.js').replace(/\\/g, '\\\\')}');`,
    `createProcessFailureHandlers({ logError: (kind, cause) => writeStructuredLog(console, 'error', 'process.unhandled_rejection', null, { runtime: 'test', errorCode: failureCodeFor(kind, cause) }) }).bind();`,
    `Promise.reject(Object.assign(new Error('gate-a1-probe'), { code: 'GATE_A1_PROBE' }));`,
    `setTimeout(() => { console.error('STILL_ALIVE'); process.exit(99); }, 2000);`,
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 8000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(result.code, 1, `exit code; stdout=${result.stdout}; stderr=${result.stderr}`);
  assert.match(result.stderr, /process\.unhandled_rejection/, `taxonomy event missing; stderr=${result.stderr}`);
  assert.match(result.stderr, /GATE_A1_PROBE/, `cause code missing; stderr=${result.stderr}`);
  assert.doesNotMatch(result.stdout + result.stderr, /STILL_ALIVE/, 'handler swallowed the failure instead of exiting');
});
