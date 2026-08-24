'use strict';

/**
 * Bounded SQLite busy-retry must work on the main thread.
 *
 * #1261 reported that `syncSleep`'s `Atomics.wait` cannot be called on the main
 * thread in Node and therefore masks every SQLITE_BUSY error with a TypeError.
 * That restriction is a browser one; Node permits `Atomics.wait` on the main
 * thread, so the retry loop works as written.
 *
 * These tests exist so the claim stays settled by execution rather than by
 * argument: they run on the main thread by construction, and they fail loudly
 * if a sleep implementation ever starts throwing there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { isMainThread } = require('node:worker_threads');

const { runWithBusyRetry, syncSleep } = require('../lib/memory-store-utils');

function busyError() {
  const error = new Error('database is locked');
  error.code = 'SQLITE_BUSY';
  return error;
}

test('the test itself runs on the main thread', () => {
  assert.equal(isMainThread, true, 'otherwise these tests prove nothing about the reported context');
});

test('syncSleep does not throw on the main thread and actually waits', () => {
  const started = Date.now();

  assert.doesNotThrow(() => syncSleep(30));

  assert.ok(Date.now() - started >= 25, 'the sleep must not return immediately');
});

test('syncSleep returns immediately for a non-positive duration', () => {
  const started = Date.now();

  syncSleep(0);
  syncSleep(-5);

  assert.ok(Date.now() - started < 25);
});

test('a busy operation is retried and can succeed', () => {
  let attempts = 0;

  const result = runWithBusyRetry(() => {
    attempts += 1;
    if (attempts < 3) throw busyError();
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3, 'the default sleep must not abort the loop');
});

test('an exhausted retry surfaces the busy error, not a sleep error', () => {
  let attempts = 0;

  assert.throws(
    () => runWithBusyRetry(() => { attempts += 1; throw busyError(); }, { label: 'test-op' }),
    (error) => {
      assert.equal(error.code, 'SQLITE_BUSY', 'the original busy error must not be masked');
      assert.equal(error.busyRetries, attempts);
      assert.equal(error.busyLabel, 'test-op');
      return true;
    },
  );
});

test('a non-busy error is not retried', () => {
  let attempts = 0;

  assert.throws(() => runWithBusyRetry(() => {
    attempts += 1;
    throw new Error('something else');
  }), /something else/);

  assert.equal(attempts, 1);
});
