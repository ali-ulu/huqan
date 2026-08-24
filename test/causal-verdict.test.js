'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CAUSAL_VERDICT_STATUSES,
  buildCausalTrace,
  buildCausalVerdict,
  scoreCausalVerdict,
  normalizeCausalVerdict,
} = require('../lib/causal');

function edge(edgeId, from, to, relation, strength = 0.8, confidence = 0.8) {
  return {
    edgeId,
    from,
    to,
    relation,
    strength,
    confidence,
  };
}

function traversalFixture(overrides = {}) {
  return {
    ok: true,
    traversal: {
      startId: 'claim-1',
      workspaceId: 'workspace-a',
      completed: true,
      stopReason: 'terminus',
      stopReasons: ['terminus'],
      visitedEdgeCount: 1,
      visitedNodeCount: 2,
      maxDepthReached: 1,
      traversalOrder: [edge('e1', 'A', 'B', 'CAUSES')],
      blockedBranches: [],
      cycleNodeIds: [],
      cycleEdgeIds: [],
      warnings: [],
      ...overrides,
    },
    meta: {
      source: 'causal-traversal',
      version: '1.0.0',
    },
  };
}

test('CAUSAL_VERDICT_STATUSES is frozen and stable', () => {
  assert.ok(Object.isFrozen(CAUSAL_VERDICT_STATUSES));
  assert.deepStrictEqual([...CAUSAL_VERDICT_STATUSES], [
    'supports',
    'contradicts',
    'inconclusive',
    'cycle_blocked',
    'depth_incomplete',
  ]);
});

test('terminus with non-empty traversal resolves to supports', () => {
  const result = buildCausalVerdict(traversalFixture());

  assert.equal(result.ok, true);
  assert.equal(result.verdict.status, 'supports');
  assert.ok(result.verdict.confidence >= 0);
  assert.ok(result.verdict.confidence <= 1);
  assert.deepEqual(result.meta, {
    source: 'causal-traversal',
    version: '1.0.0',
  });
  assert.equal(result.verdict.trace.startId, 'claim-1');
  assert.equal(result.verdict.trace.workspaceId, 'workspace-a');
  assert.equal(result.verdict.trace.stopReason, 'terminus');
  assert.equal(result.verdict.trace.supportingEdges.length, 1);
  assert.equal(JSON.stringify(result).includes('verify.status'), false);
});

test('terminus with empty traversal is inconclusive', () => {
  const result = buildCausalVerdict(traversalFixture({
    visitedEdgeCount: 0,
    visitedNodeCount: 1,
    maxDepthReached: 0,
    traversalOrder: [],
    stopReasons: ['terminus'],
  }));

  assert.equal(result.verdict.status, 'inconclusive');
  assert.equal(result.verdict.trace.supportingEdges.length, 0);
});

test('missing_start is inconclusive', () => {
  const result = buildCausalVerdict(traversalFixture({
    startId: 'missing',
    completed: false,
    stopReason: 'missing_start',
    stopReasons: ['missing_start'],
    visitedEdgeCount: 0,
    visitedNodeCount: 0,
    maxDepthReached: 0,
    traversalOrder: [],
  }));

  assert.equal(result.verdict.status, 'inconclusive');
  assert.equal(result.verdict.trace.stopReason, 'missing_start');
});

test('depth_exceeded maps to depth_incomplete', () => {
  const result = buildCausalVerdict(traversalFixture({
    completed: false,
    stopReason: 'depth_exceeded',
    stopReasons: ['depth_exceeded'],
    visitedEdgeCount: 1,
    visitedNodeCount: 2,
    maxDepthReached: 1,
    traversalOrder: [edge('e1', 'A', 'B', 'CAUSES')],
    blockedBranches: [
      {
        reason: 'depth_exceeded',
        edgeId: 'e2',
        from: 'B',
        to: 'C',
        relation: 'CAUSES',
        depth: 1,
        nextDepth: 2,
      },
    ],
    warnings: [
      { code: 'MAX_DEPTH_EXCEEDED', message: 'max depth exceeded', field: null, nodeId: 'C', depth: 2 },
    ],
  }));

  assert.equal(result.verdict.status, 'depth_incomplete');
  assert.ok(result.verdict.warnings.includes('PARTIAL_TRAVERSAL'));
});

test('max_edges_exceeded maps to depth_incomplete', () => {
  const result = buildCausalVerdict(traversalFixture({
    completed: false,
    stopReason: 'max_edges_exceeded',
    stopReasons: ['max_edges_exceeded'],
    visitedEdgeCount: 2,
    visitedNodeCount: 3,
    maxDepthReached: 2,
    traversalOrder: [
      edge('e1', 'A', 'B', 'CAUSES'),
      edge('e2', 'B', 'C', 'ENABLES'),
    ],
    blockedBranches: [
      {
        reason: 'max_edges_exceeded',
        edgeId: 'e3',
        from: 'A',
        to: 'D',
        relation: 'LEADS_TO',
        depth: 0,
        nextDepth: 1,
        maxEdges: 2,
      },
    ],
  }));

  assert.equal(result.verdict.status, 'depth_incomplete');
  assert.ok(result.verdict.warnings.includes('PARTIAL_TRAVERSAL'));
});

test('cycle_detected maps to cycle_blocked', () => {
  const result = buildCausalVerdict(traversalFixture({
    completed: false,
    stopReason: 'cycle_detected',
    stopReasons: ['cycle_detected'],
    visitedEdgeCount: 2,
    visitedNodeCount: 3,
    maxDepthReached: 2,
    traversalOrder: [
      edge('e1', 'A', 'B', 'CAUSES'),
      edge('e2', 'B', 'A', 'CAUSES'),
    ],
    blockedBranches: [
      {
        reason: 'cycle_detected',
        edgeId: 'e2',
        from: 'B',
        to: 'A',
        relation: 'CAUSES',
        depth: 1,
        nextDepth: 2,
        cycleNodeId: 'A',
      },
    ],
    cycleNodeIds: ['A'],
    cycleEdgeIds: ['e2'],
  }));

  assert.equal(result.verdict.status, 'cycle_blocked');
  assert.ok(result.verdict.riskFlags.includes('circular_reasoning_risk'));
});

test('PREVENTS-only traversal is contradictory and separated from support evidence', () => {
  const result = buildCausalVerdict(traversalFixture({
    traversalOrder: [
      edge('e1', 'A', 'B', 'PREVENTS'),
    ],
  }));

  assert.equal(result.verdict.status, 'contradicts');
  assert.equal(result.verdict.trace.supportingEdges.length, 0);
  assert.equal(result.verdict.trace.preventingEdges.length, 1);
  assert.equal(result.verdict.trace.preventingEdges[0].edgeId, 'e1');
  assert.ok(result.verdict.warnings.includes('PREVENTS_SIGNAL'));
  assert.ok(result.verdict.riskFlags.includes('prevents_signal'));
  assert.ok(result.verdict.reasons.includes('PREVENTS_ONLY_SIGNAL'));
  assert.equal(result.verdict.reasons.includes('CAUSAL_PATH_FOUND'), false);
});

test('explicit contradiction metadata preserves its reason and produces contradicts', () => {
  const result = buildCausalVerdict(
    traversalFixture({
      traversalOrder: [
        edge('e1', 'A', 'B', 'CAUSES'),
      ],
    }),
    {
      contradictionSignal: {
        reason: 'observed_counterexample_in_2024_audit',
        confidence: 0.95,
        edges: [],
      },
    },
  );

  assert.equal(result.verdict.status, 'contradicts');
  assert.ok(result.verdict.warnings.includes('EXPLICIT_CONTRADICTION_SIGNAL'));
  assert.ok(result.verdict.riskFlags.includes('explicit_contradiction_signal'));
  assert.equal(result.verdict.trace.contradictingEdges.length, 1);
  assert.equal(result.verdict.trace.contradictingEdges[0].reason, 'observed_counterexample_in_2024_audit');
  assert.ok(result.verdict.reasons.includes('observed_counterexample_in_2024_audit'));
});

test('contradiction confidence scales the contradicts score', () => {
  const weak = buildCausalVerdict(
    traversalFixture(),
    { contradictionSignal: { reason: 'weak_signal', confidence: 0.01 } },
  );
  const strong = buildCausalVerdict(
    traversalFixture(),
    { contradictionSignal: { reason: 'strong_signal', confidence: 0.99 } },
  );

  assert.equal(weak.verdict.status, 'contradicts');
  assert.equal(strong.verdict.status, 'contradicts');
  assert.ok(weak.verdict.confidence < strong.verdict.confidence);
  assert.ok(weak.verdict.confidence < 1);
});

test('confidence is deterministic and clamped to [0, 1]', () => {
  const high = buildCausalVerdict(traversalFixture({
    traversalOrder: [
      edge('e1', 'A', 'B', 'CAUSES', 1, 1),
      edge('e2', 'B', 'C', 'ENABLES', 1, 1),
      edge('e3', 'C', 'D', 'LEADS_TO', 1, 1),
      edge('e4', 'D', 'E', 'DEPENDS_ON', 1, 1),
      edge('e5', 'E', 'F', 'CAUSES', 1, 1),
      edge('e6', 'F', 'G', 'CAUSES', 1, 1),
    ],
    visitedEdgeCount: 6,
    visitedNodeCount: 7,
    maxDepthReached: 6,
  }));

  const low = buildCausalVerdict(traversalFixture({
    completed: false,
    stopReason: 'cycle_detected',
    stopReasons: ['cycle_detected'],
    visitedEdgeCount: 0,
    visitedNodeCount: 1,
    maxDepthReached: 0,
    traversalOrder: [],
    blockedBranches: Array.from({ length: 20 }, (_, index) => ({
      reason: 'cycle_detected',
      edgeId: `e${index}`,
      from: 'A',
      to: 'A',
      relation: 'CAUSES',
      depth: 0,
      nextDepth: 1,
    })),
    warnings: Array.from({ length: 20 }, (_, index) => ({
      code: `WARN_${index}`,
      message: `warning ${index}`,
      field: null,
      nodeId: 'A',
      depth: 1,
    })),
  }));

  const repeat = buildCausalVerdict(traversalFixture({
    traversalOrder: [
      edge('e1', 'A', 'B', 'CAUSES', 1, 1),
      edge('e2', 'B', 'C', 'ENABLES', 1, 1),
      edge('e3', 'C', 'D', 'LEADS_TO', 1, 1),
      edge('e4', 'D', 'E', 'DEPENDS_ON', 1, 1),
      edge('e5', 'E', 'F', 'CAUSES', 1, 1),
      edge('e6', 'F', 'G', 'CAUSES', 1, 1),
    ],
    visitedEdgeCount: 6,
    visitedNodeCount: 7,
    maxDepthReached: 6,
  }));

  assert.equal(high.verdict.confidence >= 0 && high.verdict.confidence <= 1, true);
  assert.equal(low.verdict.confidence >= 0 && low.verdict.confidence <= 1, true);
  assert.deepStrictEqual(high, repeat);
});

test('output does not expose verify.status and stays stable', () => {
  const first = buildCausalVerdict(traversalFixture());
  const second = buildCausalVerdict(traversalFixture());

  assert.deepStrictEqual(first, second);
  assert.equal(JSON.stringify(first).includes('verify.status'), false);
  assert.equal(first.verdict.trace.supportingEdges[0].edgeId, 'e1');
  assert.equal(typeof first.verdict.confidence, 'number');
});

test('buildCausalTrace and scoreCausalVerdict can be used independently', () => {
  const traversal = traversalFixture({
    traversalOrder: [
      edge('e1', 'A', 'B', 'CAUSES', 0.9, 0.8),
      edge('e2', 'B', 'C', 'ENABLES', 0.7, 0.6),
    ],
  });
  const trace = buildCausalTrace(traversal);
  const confidence = scoreCausalVerdict('supports', trace);
  const verdict = normalizeCausalVerdict({
    ok: true,
    verdict: {
      status: 'supports',
      confidence,
      reasons: ['CAUSAL_PATH_FOUND'],
      warnings: [],
      riskFlags: [],
      trace,
    },
    meta: { source: 'causal-traversal', version: '1.0.0' },
  });

  assert.equal(verdict.verdict.trace.traversalSummary.totalEdges, 2);
  assert.equal(verdict.verdict.status, 'supports');
  assert.ok(verdict.verdict.confidence >= 0 && verdict.verdict.confidence <= 1);
});
