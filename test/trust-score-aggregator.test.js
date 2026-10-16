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
const crypto = require('node:crypto');

const {
  SCORE_SCHEMA_VERSION,
  CERTIFIED_MIN_SCORE,
  computeTrustScore,
} = require('../lib/trust-score-aggregator');

function proxyEntry(status, model = 'gpt-4o-mini') {
  return { operationId: `llm-proxy:${crypto.randomUUID()}`, status: 'completed', result: { proxied: true, model, upstreamStatus: status }, committedAt: '2026-09-06T00:00:00.000Z' };
}

function routingDecidedEntry(chosenCapabilityId = null, refusalReason = null) {
  const decision = {
    eventType: 'routing_decided',
    requestId: 'req-1',
    candidatesConsidered: [],
    chosenCapabilityId,
    boundProcedureVersion: chosenCapabilityId ? 'proc-v1' : null,
    refusalReason,
    matchRuleVersion: 'structural-subset-v1',
    matchScoreVersion: 'unused-v1',
    tiebreakRuleVersion: 'specificity-trust-lexicographic-v1',
    trustSnapshotVersion: 'cap-trust-v1',
  };
  return {
    operationId: `routing_decided:${crypto.randomUUID()}`,
    status: 'completed',
    result: { decision },
    committedAt: '2026-09-06T00:00:00.000Z',
  };
}

function stubGraph({ proxy = [], claims = [], routing = [] } = {}) {
  return {
    getCommittedMutationResultsByPrefix: (prefix) => {
      if (prefix === 'llm-proxy:') return proxy;
      if (prefix === 'routing_decided') return routing;
      return [];
    },
    getCandidateClaims: () => claims,
  };
}

function stubCapabilityTrustRegistry({ fallbackCounts = {} } = {}) {
  const entries = Object.entries(fallbackCounts).map(([capabilityId, count]) => ({
    capabilityId,
    fallbackPreferredOverCount: count,
  }));
  return {
    getAll: () => entries,
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

test('AI dependency ratio included in output when enabled', () => {
  const proxy = [proxyEntry(200), proxyEntry(200)];
  const routing = [routingDecidedEntry('cap-1'), routingDecidedEntry('cap-2')];
  const trustRegistry = stubCapabilityTrustRegistry({ fallbackCounts: { 'cap-1': 1 } });
  const graph = stubGraph({ proxy, routing });
  const out = computeTrustScore({ graph, capabilityTrustRegistry: trustRegistry, workspaceId: 'default' });
  assert.ok(out.aiDependencyRatio);
  assert.equal(out.aiDependencyRatio.schemaVersion, 'huqan-ai-dependency-ratio-v1');
  assert.equal(out.aiDependencyRatio.workspaceId, 'default');
  assert.equal(out.aiDependencyRatio.modelCalls, 2);
  assert.equal(out.aiDependencyRatio.deterministicServes, 2);
  assert.equal(out.aiDependencyRatio.permittedFallbacks, 1);
  assert.equal(out.aiDependencyRatio.totalRequests, 5);
  assert.equal(out.aiDependencyRatio.deterministicRatio, Number((2/5).toFixed(4)));
  assert.equal(out.aiDependencyRatio.permittedFallbackShare, Number((1/5).toFixed(4)));
});

test('AI dependency ratio can be disabled', () => {
  const proxy = [proxyEntry(200)];
  const routing = [routingDecidedEntry('cap-1')];
  const graph = stubGraph({ proxy, routing });
  const out = computeTrustScore({ graph, workspaceId: 'default', includeAiDependencyRatio: false });
  assert.equal(out.aiDependencyRatio, undefined);
});

test('AI dependency ratio with only model calls (no deterministic serves)', () => {
  const proxy = [proxyEntry(200), proxyEntry(502)];
  const graph = stubGraph({ proxy });
  const out = computeTrustScore({ graph, workspaceId: 'default' });
  assert.ok(out.aiDependencyRatio);
  assert.equal(out.aiDependencyRatio.modelCalls, 2);
  assert.equal(out.aiDependencyRatio.deterministicServes, 0);
  assert.equal(out.aiDependencyRatio.deterministicRatio, 0);
});

test('AI dependency ratio with refusals counted separately', () => {
  const routing = [
    routingDecidedEntry('cap-1'),
    routingDecidedEntry(null, 'no_structural_match'),
    routingDecidedEntry(null, 'no_eligible_match'),
  ];
  const graph = stubGraph({ routing });
  const out = computeTrustScore({ graph, workspaceId: 'default' });
  assert.ok(out.aiDependencyRatio);
  assert.equal(out.aiDependencyRatio.deterministicServes, 1);
  assert.equal(out.aiDependencyRatio.refusals, 2);
  assert.equal(out.aiDependencyRatio.totalRoutingDecisions, 3);
});