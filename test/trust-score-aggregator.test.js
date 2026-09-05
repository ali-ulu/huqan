'use strict';

/**
 * Trust Score aggregator (#1910).
 *
 * Locks in: deterministic math on stubbed signals, insufficient-data
 * honesty, certification gating, window capping, and malformed-entry
 * tolerance.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  SCORE_SCHEMA_VERSION,
  CERTIFIED_MIN_SCORE,
  computeTrustScore,
} = require('../lib/trust-score-aggregator');

function proxyEntry(status, model = 'gpt-4o-mini') {
  return { operationId: 'llm-proxy:x', status: 'completed', result: { proxied: true, model, upstreamStatus: status }, committedAt: '2026-09-06T00:00:00.000Z' };
}

function stubGraph({ proxy = [], claims = [] } = {}) {
  return {
    getCommittedMutationResultsByPrefix: (prefix) => {
      assert.equal(prefix, 'llm-proxy:');
      return proxy;
    },
    getCandidateClaims: () => claims,
  };
}

test('empty workspace yields insufficient-data, never a fabricated score', () => {
  const out = computeTrustScore({ graph: stubGraph(), workspaceId: 'default' });
  assert.equal(out.schemaVersion, SCORE_SCHEMA_VERSION);
  assert.equal(out.status, 'insufficient-data');
  assert.equal(out.score, null);
  assert.equal(out.certified, false);
});

test('scoring math: errors, approval backlog and review backlog deduct', () => {
  // 20 actions, 2 upstream errors (10% -> -4), backlog 3 (-3), 10 claims (-2) => 91.
  const proxy = Array.from({ length: 18 }, () => proxyEntry(200)).concat([proxyEntry(502), proxyEntry(503)]);
  const claims = Array.from({ length: 10 }, (_, i) => ({ candidateId: `c${i}` }));
  const out = computeTrustScore({
    graph: stubGraph({ proxy, claims }),
    workspaceId: 'default',
    approvalCounts: { pending: 2, unresolved: 1 },
  });
  assert.equal(out.status, 'scored');
  assert.equal(out.windowActions, 20);
  assert.deepEqual(out.deductions, { upstreamErrors: 4, approvalBacklog: 3, reviewBacklog: 2 });
  assert.equal(out.score, 91);
  assert.equal(out.certified, false);
});

test('certification requires score and action volume', () => {
  const proxy = Array.from({ length: 150 }, () => proxyEntry(200));
  const clean = computeTrustScore({ graph: stubGraph({ proxy }), workspaceId: 'default', approvalCounts: { pending: 0, unresolved: 0 } });
  assert.equal(clean.score, 100);
  assert.equal(clean.certified, true);

  const thin = computeTrustScore({ graph: stubGraph({ proxy: proxy.slice(0, 50) }), workspaceId: 'default', approvalCounts: { pending: 0, unresolved: 0 } });
  assert.equal(thin.score, 100);
  assert.equal(thin.certified, false);

  const weakProxy = proxy.slice(0, 140).concat(Array.from({ length: 10 }, () => proxyEntry(502)));
  const weak = computeTrustScore({ graph: stubGraph({ proxy: weakProxy }), workspaceId: 'default', approvalCounts: { pending: 10, unresolved: 10 } });
  assert.ok(weak.score < CERTIFIED_MIN_SCORE);
  assert.equal(weak.certified, false);
});

test('window cap bounds the scan and malformed entries are tolerated', () => {
  const proxy = Array.from({ length: 120 }, () => proxyEntry(200));
  proxy.push(null, {}, { result: null }, { result: { upstreamStatus: 'oops' } });
  const out = computeTrustScore({ graph: stubGraph({ proxy }), workspaceId: 'default', windowMax: 100 });
  assert.equal(out.windowActions, 100);
  assert.equal(out.score, 100);
  assert.equal(out.signals.proxy.windowCapped, true);
});
