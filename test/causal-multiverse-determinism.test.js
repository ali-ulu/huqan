'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const Graph = require('../graph');
const {
  buildCausalVerdict,
  stableStringify,
  traverseCausalGraph,
} = require('../lib/causal');
const { buildTrustReceipt } = require('../lib/provenance-query');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-v1-pr5-'));

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createTraversalAdapter() {
  const nodes = new Map([
    ['A', { id: 'A' }],
    ['B', { id: 'B' }],
    ['C', { id: 'C' }],
    ['D', { id: 'D' }],
  ]);
  const edges = [
    { edgeId: 'e1', from: 'A', to: 'B', relation: 'CAUSES', strength: 0.94, confidence: 0.93 },
    { edgeId: 'e2', from: 'B', to: 'C', relation: 'ENABLES', strength: 0.87, confidence: 0.91 },
    { edgeId: 'e3', from: 'C', to: 'D', relation: 'PREVENTS', strength: 0.28, confidence: 0.36 },
  ];

  return {
    getNode(id) {
      return nodes.get(id) || null;
    },
    getEdges(id) {
      return edges.filter(edge => edge.from === id);
    },
  };
}

function createReceiptGraph(universeIndex) {
  const graph = new Graph({
    useSQLite: false,
    noLoad: true,
    memoryPath: path.join(tempDir, `universe-${universeIndex}.json`),
  });

  const provenance = {
    provenanceId: 'prov-v1-pr5-example',
    sourceRef: 'docs/demo-v1-causal-granite.md#example',
    sourceTitle: 'V1 causal granite demo',
    sourceType: 'document',
    sourceSubType: 'note',
    actor: 'huqan-core',
    timestamp: '2026-06-05T00:00:00Z',
    confidence: 0.88,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '1.0.0',
  };

  graph.addNode('A', 'A canonical claim', provenance, { workspaceId: 'workspace-a' });
  return graph;
}

function stripVolatileReceiptFields(receipt) {
  const { receiptId, generatedAt, ...rest } = receipt;
  return rest;
}

function runUniverse(index) {
  const traversal = traverseCausalGraph(createTraversalAdapter(), 'A', {
    workspaceId: 'workspace-a',
    maxDepth: 8,
    maxEdges: 8,
  });
  const verdict = buildCausalVerdict(traversal);
  const receipt = buildTrustReceipt({
    targetId: 'A',
    workspaceId: 'workspace-a',
    causalVerdict: verdict,
  }, { target: createReceiptGraph(index) });

  return {
    traversal,
    verdict,
    receipt: stripVolatileReceiptFields(receipt),
  };
}

test('same causal scenario is stable across isolated universes', () => {
  const universes = Array.from({ length: 25 }, (_, index) => runUniverse(index));
  const baseline = universes[0];

  for (const universe of universes.slice(1)) {
    assert.equal(stableStringify(universe.traversal), stableStringify(baseline.traversal));
    assert.equal(stableStringify(universe.verdict), stableStringify(baseline.verdict));
    assert.equal(stableStringify(universe.receipt), stableStringify(baseline.receipt));
  }

  assert.equal(baseline.traversal.traversal.stopReason, 'terminus');
  assert.equal(baseline.verdict.verdict.status, 'supports');
  assert.equal(baseline.receipt.causal.bridge, 'pass');
  assert.equal(baseline.receipt.status, 'canonical');
  assert.equal(JSON.stringify(baseline.receipt).includes('verify.status'), false);
});
