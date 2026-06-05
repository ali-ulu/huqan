'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Graph = require('../graph');
const {
  buildTrustReceipt,
  queryProvenance,
  queryTrustGraph,
} = require('../lib/provenance-query');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-entity-provenance-alignment-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeGraph(label) {
  return new Graph({
    useSQLite: false,
    memoryPath: path.join(tempDir, `${label}.json`),
  });
}

function seedEdge(graph, { includeMeta = true } = {}) {
  graph.addNode('b737', 'Boeing 737', { source: 'seed', workspaceId: 'default' }, { workspaceId: 'default' });
  graph.addNode('aircraft', 'Aircraft', { source: 'seed', workspaceId: 'default' }, { workspaceId: 'default' });

  return graph.addEdge('b737', 'aircraft', 'CAUSES', {
    workspaceId: 'default',
    strength: 0.72,
    weight: 0.88,
    confidence: 0.91,
    source: 'learn',
    sourceRef: 'claim-1',
    sessionId: 'session-1',
    evidence: ['seed-fact'],
    evidenceType: 'seed',
    provenance: { source: 'fixture', workspaceId: 'default' },
    companyMode: true,
    sourceType: 'benchmark',
    meta: includeMeta
      ? {
          entityResolution: {
            originalLiteral: 'B737',
            canonicalId: 'boeing_737',
            domain: 'aviation',
            reason: 'exact_alias',
            matched: true,
          },
        }
      : undefined,
  });
}

function simplifyEntityResolution(entityResolution) {
  if (!entityResolution) return entityResolution;
  return {
    original: entityResolution.original,
    canonical: entityResolution.canonical,
    domain: entityResolution.domain,
    reason: entityResolution.reason,
    matched: entityResolution.matched,
    originalLiteral: entityResolution.originalLiteral,
    canonicalId: entityResolution.canonicalId,
  };
}

test('queryProvenance exposes edge.meta.entityResolution without mutating the graph', () => {
  const graph = makeGraph('provenance');
  seedEdge(graph, { includeMeta: true });

  const before = {
    nodes: graph.nodeCount('default'),
    edges: graph.edgeCount('default'),
  };
  const beforeMeta = graph.getEdge('b737', 'aircraft', 'CAUSES', 'default').meta;

  const records = queryProvenance(graph, {
    workspaceId: 'default',
    targetId: 'b737|CAUSES|aircraft',
  });

  const after = {
    nodes: graph.nodeCount('default'),
    edges: graph.edgeCount('default'),
  };
  const afterMeta = graph.getEdge('b737', 'aircraft', 'CAUSES', 'default').meta;

  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'edge');
  assert.deepStrictEqual(simplifyEntityResolution(records[0].entityResolution), {
    original: 'B737',
    canonical: 'boeing_737',
    domain: 'aviation',
    reason: 'exact_alias',
    matched: true,
    originalLiteral: 'B737',
    canonicalId: 'boeing_737',
  });
  assert.equal(records[0].canonical, true);
  assert.deepStrictEqual(after, before);
  assert.deepStrictEqual(afterMeta, beforeMeta);

  graph.close();
});

test('buildTrustReceipt surfaces entityResolution while keeping trust status separate', () => {
  const graphWithMeta = makeGraph('receipt-with-meta');
  seedEdge(graphWithMeta, { includeMeta: true });

  const graphWithoutMeta = makeGraph('receipt-without-meta');
  seedEdge(graphWithoutMeta, { includeMeta: false });

  const filters = {
    workspaceId: 'default',
    targetId: 'b737|CAUSES|aircraft',
  };

  const receiptWithMeta = buildTrustReceipt(filters, { target: graphWithMeta });
  const receiptWithoutMeta = buildTrustReceipt(filters, { target: graphWithoutMeta });
  const trustGraph = queryTrustGraph(graphWithMeta, filters);

  assert.equal(receiptWithMeta.status, receiptWithoutMeta.status);
  assert.equal(receiptWithMeta.canonical, receiptWithoutMeta.canonical);
  assert.equal(receiptWithMeta.canonical, true);
  assert.equal(receiptWithoutMeta.entityResolution, undefined);
  assert.deepStrictEqual(simplifyEntityResolution(receiptWithMeta.entityResolution), {
    original: 'B737',
    canonical: 'boeing_737',
    domain: 'aviation',
    reason: 'exact_alias',
    matched: true,
    originalLiteral: 'B737',
    canonicalId: 'boeing_737',
  });
  assert.deepStrictEqual(simplifyEntityResolution(trustGraph.receipt.entityResolution), {
    original: 'B737',
    canonical: 'boeing_737',
    domain: 'aviation',
    reason: 'exact_alias',
    matched: true,
    originalLiteral: 'B737',
    canonicalId: 'boeing_737',
  });
  assert.equal(trustGraph.receipt.canonical, true);
  assert.equal(trustGraph.status, receiptWithMeta.status);

  graphWithMeta.close();
  graphWithoutMeta.close();
});

test('queryTrustGraph remains backward compatible when entityResolution metadata is absent', () => {
  const graph = makeGraph('no-meta');
  seedEdge(graph, { includeMeta: false });

  const receipt = buildTrustReceipt({
    workspaceId: 'default',
    targetId: 'b737|CAUSES|aircraft',
  }, { target: graph });
  const provenance = queryProvenance(graph, {
    workspaceId: 'default',
    targetId: 'b737|CAUSES|aircraft',
  });

  assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'entityResolution'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(provenance[0], 'entityResolution'), false);

  graph.close();
});
