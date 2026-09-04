'use strict';

/**
 * The browser smoke harness must fail, not hang (#1853).
 *
 * A CI shard killed test/ui-pr-guardian-readiness-browser-smoke.test.js at the
 * 90s per-file cap with no test output at all: the launch hook was parked on an
 * unbounded `fetch` to the browser's DevTools endpoint. Every other await in
 * that hook rejects within 20-30s, so the poll was the one path that could
 * swallow a run silently.
 *
 * This drives that poll against a server that behaves exactly like the bad case
 * -- it accepts the connection and never answers -- and requires the poll to
 * reject on its own deadline. Running the real browser is not needed to state
 * the property, and would not reproduce the condition on demand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { firstPageTarget } = require('./helpers/cdp-browser');

/** A DevTools endpoint that accepts requests and never responds to them. */
function silentEndpoint(t) {
  const held = [];
  const server = http.createServer((request, response) => { held.push(response); });
  t.after(() => {
    // Release the parked responses first, or close() waits on them.
    for (const response of held) { try { response.destroy(); } catch { /* already gone */ } }
    return new Promise(resolve => server.close(() => resolve()));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('an unanswered DevTools endpoint fails on the deadline instead of hanging', async t => {
  const port = await silentEndpoint(t);
  const startedAt = Date.now();

  await assert.rejects(
    () => firstPageTarget(port, { deadlineMs: 1_500 }),
    /never exposed a page target within 1500ms/,
    'the poll must name its own deadline rather than wait for the caller to be killed',
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 15_000, `poll returned only after ${elapsed}ms; it is not bounded by its deadline`);
});

test('a closed port fails on the deadline too, and says what it last saw', async t => {
  // Nothing listening: every attempt is refused immediately, so this proves the
  // loop ends on the deadline rather than on an exhausted attempt counter.
  const port = await silentEndpoint(t);
  const startedAt = Date.now();

  await assert.rejects(
    () => firstPageTarget(port + 1, { deadlineMs: 500 }),
    error => /never exposed a page target within 500ms/.test(error.message)
      && /last attempt: /.test(error.message),
  );

  assert.ok(Date.now() - startedAt < 15_000, 'a refused port must not extend the deadline');
});
