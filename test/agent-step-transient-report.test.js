'use strict';

// isTransientStepReport decides whether a failed step is retried (V1) and
// whether V3 proposes a repair (lib/experience/run-repair.js). It reads the
// failure text from several places, in order; each source is pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isTransientStepReport } = require('../lib/agent-step-executor');

test('the error message, code, bare error and summary are each read', () => {
  assert.equal(isTransientStepReport({ result: { error: { message: 'Request timeout' } } }), true);
  assert.equal(isTransientStepReport({ result: { error: { code: 'ECONNRESET' } } }), true);
  assert.equal(isTransientStepReport({ result: { error: 'upstream returned 503' } }), true);
  assert.equal(isTransientStepReport({ summary: 'network unreachable' }), true);
});

test('the message wins over the code', () => {
  assert.equal(isTransientStepReport({ result: { error: { message: 'invalid input', code: 'ETIMEDOUT' } } }), false);
});

test('a permanent failure or an empty report is not transient', () => {
  assert.equal(isTransientStepReport({ result: { error: { message: 'permission denied' } } }), false);
  assert.equal(isTransientStepReport({ result: {} }), false);
  assert.equal(isTransientStepReport({}), false);
  assert.equal(isTransientStepReport(), false);
});
