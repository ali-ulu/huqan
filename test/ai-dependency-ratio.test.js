'use strict';

/**
 * AI Dependency Ratio (#3028).
 *
 * Locks in: deterministic math on stubbed signals, insufficient-data
 * honesty, ratio bounds, and malformed-entry tolerance.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  SCHEMA_VERSION,
  computeAiDependencyRatio,
  collectModelCallSignals,
  collectRoutingSignals,
  collectPermittedFallbackSignals,
  collectEffectVerificationSignals,
} = require('../lib/ai-dependency-ratio');

const { EFFECT_VERIFICATION } = require('../lib/external-action-receipt-outcome');

function llmProxyEntry(model = 'gpt-4o-mini', status = 200) {
  return {
    operationId: `llm-proxy:${crypto.randomUUID()}`,
    status: 'completed',
    result: { proxied: true, model, upstreamStatus: status },
    committedAt: new Date().toISOString(),
  };
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
    committedAt: new Date().toISOString(),
  };
}

function stubGraph({ proxy = [], routing = [] } = {}) {
  return {
    getCommittedMutationResultsByPrefix: (prefix) => {
      if (prefix === 'llm-proxy:') return proxy;
      if (prefix === 'routing_decided') return routing;
      return [];
    },
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

function createTempReceiptFile(entries) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-test-'));
  const filePath = path.join(tmpDir, 'receipts.jsonl');
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines);
  return filePath;
}

test('empty workspace yields insufficient-data status', () => {
  const graph = stubGraph();
  const out = computeAiDependencyRatio({ graph, workspaceId: 'default' });
  assert.equal(out.schemaVersion, SCHEMA_VERSION);
  assert.equal(out.status, 'insufficient-data');
  assert.equal(out.deterministicRatio, 0);
  assert.equal(out.totalRequests, 0);
});

test('only model calls: ratio is 0', () => {
  const proxy = [llmProxyEntry('gpt-4o', 200), llmProxyEntry('gpt-4o-mini', 200)];
  const graph = stubGraph({ proxy });
  const out = computeAiDependencyRatio({ graph, workspaceId: 'default' });
  assert.equal(out.status, 'computed');
  assert.equal(out.modelCalls, 2);
  assert.equal(out.deterministicServes, 0);
  assert.equal(out.totalRequests, 2);
  assert.equal(out.deterministicRatio, 0);
});

test('only deterministic serves: ratio is 1', () => {
  const routing = [
    routingDecidedEntry('cap-1'),
    routingDecidedEntry('cap-2'),
    routingDecidedEntry('cap-3'),
  ];
  const graph = stubGraph({ routing });
  const out = computeAiDependencyRatio({ graph, workspaceId: 'default' });
  assert.equal(out.status, 'computed');
  assert.equal(out.modelCalls, 0);
  assert.equal(out.deterministicServes, 3);
  assert.equal(out.totalRequests, 3);
  assert.equal(out.deterministicRatio, 1);
});

test('mixed: deterministic serves and model calls', () => {
  const proxy = [llmProxyEntry('gpt-4o', 200)];
  const routing = [routingDecidedEntry('cap-1'), routingDecidedEntry('cap-2')];
  const graph = stubGraph({ proxy, routing });
  const out = computeAiDependencyRatio({ graph, workspaceId: 'default' });
  assert.equal(out.modelCalls, 1);
  assert.equal(out.deterministicServes, 2);
  assert.equal(out.totalRequests, 3);
  assert.equal(out.deterministicRatio, Number((2/3).toFixed(4)));
});

test('refusals counted separately, not in deterministic serves', () => {
  const routing = [
    routingDecidedEntry('cap-1'),
    routingDecidedEntry(null, 'no_structural_match'),
    routingDecidedEntry(null, 'no_eligible_match'),
  ];
  const graph = stubGraph({ routing });
  const out = computeAiDependencyRatio({ graph, workspaceId: 'default' });
  assert.equal(out.deterministicServes, 1);
  assert.equal(out.refusals, 2);
  assert.equal(out.totalRoutingDecisions, 3);
});

test('permitted fallbacks from capability trust registry', () => {
  const routing = [routingDecidedEntry('cap-1')];
  const trustRegistry = stubCapabilityTrustRegistry({
    fallbackCounts: { 'cap-1': 2, 'cap-2': 1 },
  });
  const graph = stubGraph({ routing });
  const out = computeAiDependencyRatio({ graph, capabilityTrustRegistry: trustRegistry, workspaceId: 'default' });
  assert.equal(out.permittedFallbacks, 3);
  assert.equal(out.totalRequests, 4); // 1 deterministic + 3 fallbacks
  assert.equal(out.permittedFallbackShare, Number((3/4).toFixed(4)));
});

test('effect verification: observed vs reported split', () => {
  const receiptPath = createTempReceiptFile([
    { receiptKind: 'external_action_outcome_receipt', metadata: { effectVerification: EFFECT_VERIFICATION.OBSERVED } },
    { receiptKind: 'external_action_outcome_receipt', metadata: { effectVerification: EFFECT_VERIFICATION.OBSERVED } },
    { receiptKind: 'external_action_outcome_receipt', metadata: { effectVerification: EFFECT_VERIFICATION.REPORTED } },
    { receiptKind: 'external_action_outcome_receipt', metadata: { effectVerification: EFFECT_VERIFICATION.NONE } },
  ]);
  const out = collectEffectVerificationSignals(receiptPath);
  assert.equal(out.observed, 2);
  assert.equal(out.reported, 1);
  assert.equal(out.none, 1);
  const total = out.observed + out.reported + out.none;
  assert.equal(total, 4);
  assert.equal(Number((out.observed / total).toFixed(4)), Number((2/4).toFixed(4)));
  assert.equal(Number((out.reported / total).toFixed(4)), Number((1/4).toFixed(4)));
  // cleanup
  fs.unlinkSync(receiptPath);
  fs.rmdirSync(path.dirname(receiptPath));
});

test('malformed receipt lines are tolerated', () => {
  const receiptPath = createTempReceiptFile([
    { receiptKind: 'external_action_outcome_receipt', metadata: { effectVerification: EFFECT_VERIFICATION.OBSERVED } },
    'not valid json',
    { receiptKind: 'external_action_outcome_receipt', metadata: { effectVerification: EFFECT_VERIFICATION.REPORTED } },
    '',
  ]);
  const out = collectEffectVerificationSignals(receiptPath);
  assert.equal(out.observed, 1);
  assert.equal(out.reported, 1);
  fs.unlinkSync(receiptPath);
  fs.rmdirSync(path.dirname(receiptPath));
});

test('missing receipt file returns zeros', () => {
  const out = collectEffectVerificationSignals('/nonexistent/path/receipts.jsonl');
  assert.equal(out.observed, 0);
  assert.equal(out.reported, 0);
  assert.equal(out.none, 0);
});

test('window cap and malformed entries tolerated in collectModelCallSignals', () => {
  const proxy = [
    llmProxyEntry('gpt-4o', 200),
    llmProxyEntry('gpt-4o-mini', 200),
    null,
    {},
    { result: null },
    { result: { upstreamStatus: 'oops' } },
  ];
  const graph = stubGraph({ proxy });
  const count = collectModelCallSignals(graph);
  // Should count only valid entries with operationId starting with llm-proxy:
  assert.equal(count, 2);
});

test('collectRoutingSignals tolerates malformed entries', () => {
  const routing = [
    routingDecidedEntry('cap-1'),
    null,
    {},
    { result: null },
    { result: { decision: null } },
  ];
  const graph = stubGraph({ routing });
  const out = collectRoutingSignals(graph);
  assert.equal(out.deterministicServes, 1);
  assert.equal(out.totalRoutingDecisions, 1); // only valid ones counted
});

test('computeAiDependencyRatio includes all signals in output', () => {
  const proxy = [llmProxyEntry('gpt-4o', 200)];
  const routing = [routingDecidedEntry('cap-1'), routingDecidedEntry('cap-2')];
  const trustRegistry = stubCapabilityTrustRegistry({ fallbackCounts: { 'cap-1': 1 } });
  const receiptPath = createTempReceiptFile([
    { receiptKind: 'external_action_outcome_receipt', metadata: { effectVerification: EFFECT_VERIFICATION.OBSERVED } },
  ]);
  const graph = stubGraph({ proxy, routing });
  const out = computeAiDependencyRatio({ graph, capabilityTrustRegistry: trustRegistry, receiptPath, workspaceId: 'ws-1' });
  assert.equal(out.workspaceId, 'ws-1');
  assert.equal(out.modelCalls, 1);
  assert.equal(out.deterministicServes, 2);
  assert.equal(out.permittedFallbacks, 1);
  assert.equal(out.totalRequests, 4);
  assert.equal(out.refusals, 0);
  assert.equal(out.totalRoutingDecisions, 2);
  assert.ok(out.effectVerification);
  assert.equal(out.effectVerification.observed, 1);
  assert.equal(out.effectVerification.reported, 0);
  assert.equal(out.effectVerification.none, 0);
  assert.ok(out.limitations);
  assert.ok(Array.isArray(out.limitations));
  assert.ok(out.limitations.length > 0);
  // cleanup
  fs.unlinkSync(receiptPath);
  fs.rmdirSync(path.dirname(receiptPath));
});

test('deterministicRatio is bounded 0-1', () => {
  const proxy = Array.from({ length: 100 }, () => llmProxyEntry());
  const graph = stubGraph({ proxy });
  const out = computeAiDependencyRatio({ graph });
  assert.ok(out.deterministicRatio >= 0 && out.deterministicRatio <= 1);
});