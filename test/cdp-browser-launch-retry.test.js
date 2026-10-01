'use strict';

/**
 * A transient browser-launch miss is retried, not turned into a red build.
 *
 * test/ui-observability-readiness-browser-smoke.test.js was red on a loaded
 * ubuntu runner: its `before` hook spent the full 30s DevTools-endpoint deadline
 * and the five tests were cancelled with no assertion, while the identical test
 * passed locally in under 4s. The launch legs (endpoint, page target, socket)
 * cannot produce a page-behaviour failure, so a miss there is a statement about
 * the runner, not about the page under test. One retry absorbs it (#3240).
 *
 * The policy is pinned here without a real browser: `open` is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { withLaunchRetry } = require('./helpers/cdp-browser');

test('withLaunchRetry returns the first success without retrying again', async () => {
  let calls = 0;
  const result = await withLaunchRetry(async () => {
    calls += 1;
    return 'ok';
  }, 2);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withLaunchRetry retries a transient failure and returns the later success', async () => {
  let calls = 0;
  const result = await withLaunchRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error('browser did not report a DevTools endpoint in 30000ms');
    return 'ok';
  }, 2);
  assert.equal(result, 'ok');
  assert.equal(calls, 2, 'the second attempt must actually run');
});

test('withLaunchRetry rethrows the last failure once the attempts are spent', async () => {
  let calls = 0;
  await assert.rejects(
    () => withLaunchRetry(async () => {
      calls += 1;
      throw new Error(`attempt ${calls} failed`);
    }, 2),
    /attempt 2 failed/,
  );
  assert.equal(calls, 2, 'it must not retry past the bound');
});

test('withLaunchRetry always makes at least one attempt', async () => {
  let calls = 0;
  const result = await withLaunchRetry(async () => {
    calls += 1;
    return 'ok';
  }, 0);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});
