'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention, mergeWithUpstreamVerdict } = require('../lib/error-prevention');

test('error prevention merge never downgrades a stricter upstream verdict', () => {
  assert.equal(mergeWithUpstreamVerdict('block', 'allow'), 'block');
  assert.equal(mergeWithUpstreamVerdict('dry_run_only', 'review'), 'dry_run_only');
  assert.equal(mergeWithUpstreamVerdict('review', 'block'), 'block');
  assert.equal(mergeWithUpstreamVerdict('allow', 'review'), 'review');
  assert.equal(mergeWithUpstreamVerdict('unknown-verdict', 'allow'), 'block');
});

test('preflight preserves upstream block even when no prevention rule matches', () => {
  const memory = new MemoryStore({ useSQLite: false });
  const prevention = createErrorPrevention(memory);
  const result = prevention.preflight({
    operation: 'read_status',
    workspaceId: 'huqan',
  }, { upstreamVerdict: 'block' });

  assert.equal(result.preventionDecision, 'allow');
  assert.equal(result.decision, 'block');
  assert.equal(result.blocked, true);
  assert.ok(result.reasonCodes.includes('STRICTER_UPSTREAM_VERDICT_PRESERVED'));
});
