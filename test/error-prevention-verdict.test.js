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
  const result = prevention.preflight({ operation: 'read_status', workspaceId: 'huqan' }, { upstreamVerdict: 'block' });

  assert.equal(result.preventionDecision, 'allow');
  assert.equal(result.decision, 'block');
  assert.equal(result.blocked, true);
  assert.ok(result.reasonCodes.includes('STRICTER_UPSTREAM_VERDICT_PRESERVED'));
});

test('configured audit sink failure fails preflight closed to review', () => {
  const memory = new MemoryStore({ useSQLite: false });
  const prevention = createErrorPrevention(memory, { auditTarget: {} });
  const result = prevention.preflight({ operation: 'read_status', workspaceId: 'huqan' });

  assert.equal(result.ok, false);
  assert.equal(result.decision, 'review');
  assert.equal(result.allowed, false);
  assert.equal(result.receipt, null);
  assert.ok(result.reasonCodes.includes('AUDIT_WRITE_FAILED'));
});

const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__'];

test('merge fail-closes prototype key names on the prevention side (#1034)', () => {
  // `PREVENTION_PRIORITY[v] === undefined` was passed by a prototype key name:
  // the lookup returned a function, the guard did not fire, and the raw input
  // was carried through as the merged verdict. 'bogus' fell closed and
  // 'constructor' did not — the same class of unrecognized value, answered two
  // different ways.
  assert.equal(mergeWithUpstreamVerdict('allow', 'bogus'), 'block');
  for (const key of PROTOTYPE_KEYS) {
    assert.equal(mergeWithUpstreamVerdict('allow', key), 'block', key);
  }
});

test('merge fail-closes prototype key names on the upstream side too (#1034)', () => {
  for (const key of PROTOTYPE_KEYS) {
    assert.equal(mergeWithUpstreamVerdict(key, 'allow'), 'block', key);
  }
});

test('merge only ever returns a canonical verdict (#1034)', () => {
  const canonical = new Set(['allow', 'disabled', 'review', 'dry_run_only', 'quarantine', 'block']);
  const inputs = [...PROTOTYPE_KEYS, 'bogus', '', null, 0, 'allow', 'review', 'block'];
  for (const upstream of inputs) {
    for (const prevention of inputs) {
      const merged = mergeWithUpstreamVerdict(upstream, prevention);
      assert.ok(canonical.has(merged), `${String(upstream)}/${String(prevention)} -> ${String(merged)}`);
    }
  }
});

test('a prototype-named upstream verdict yields a decided preflight result (#1034)', () => {
  // A non-canonical verdict made allowed/requiresReview/blocked all false:
  // neither permitted nor stopped, so `if (!result.blocked)` proceeded.
  const { buildPreflightDecision } = require('../lib/error-prevention/decision');
  for (const key of PROTOTYPE_KEYS) {
    const result = buildPreflightDecision({ tool: 't', operation: 'o' }, [], 'v1', { upstreamVerdict: key });
    assert.equal(result.blocked, true, key);
    assert.equal(result.allowed, false, key);
    assert.equal(result.requiresReview, false, key);
    assert.equal([result.allowed, result.requiresReview, result.blocked].filter(Boolean).length, 1, key);
  }
});
