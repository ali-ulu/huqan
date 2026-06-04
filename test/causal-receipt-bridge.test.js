const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const { buildCausalVerdict } = require('../lib/causal');
const { buildTrustReceipt, queryTrustGraph } = require('../lib/provenance-query');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-causal-receipt-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeProvenance(overrides = {}) {
  return {
    provenanceId: 'prov-001',
    sourceRef: 'docs/claim.md#1',
    sourceTitle: 'Claim',
    sourceType: 'document',
    sourceSubType: 'note',
    actor: 'builder',
    timestamp: '2026-06-02T00:00:00Z',
    confidence: 0.88,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '0.8.0',
    ...overrides,
  };
}

function makeKernel() {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `memory-${Math.random().toString(16).slice(2)}.json`),
  });
  kernel.learn('kedi hayvandir', { provenance: makeProvenance() });
  return kernel;
}

function traversalFixture(stopReason, overrides = {}) {
  return {
    ok: true,
    traversal: {
      startId: 'kedi',
      workspaceId: 'workspace-a',
      completed: stopReason === 'terminus',
      stopReason,
      stopReasons: [stopReason],
      visitedEdgeCount: overrides.visitedEdgeCount ?? 1,
      visitedNodeCount: overrides.visitedNodeCount ?? 2,
      maxDepthReached: overrides.maxDepthReached ?? 1,
      traversalOrder: overrides.traversalOrder ?? [
        {
          edgeId: 'edge-1',
          from: 'kedi',
          to: 'hayvan',
          relation: 'CAUSES',
          strength: 0.8,
          confidence: 0.9,
          depth: 1,
        },
      ],
      blockedBranches: overrides.blockedBranches ?? [],
      warnings: overrides.warnings ?? [],
      cycleEdgeIds: overrides.cycleEdgeIds ?? [],
      cycleNodeIds: overrides.cycleNodeIds ?? [],
      relationPriority: overrides.relationPriority,
      ...overrides.traversal,
    },
    meta: {
      source: 'causal-traversal',
      version: '1.0.0',
      ...overrides.meta,
    },
    ...overrides.root,
  };
}

function stripVolatileReceiptFields(receipt) {
  const { receiptId, generatedAt, causal, ...rest } = receipt;
  return {
    ...rest,
    causal: causal ? {
      ...causal,
      trace: causal.trace ? { ...causal.trace } : causal.trace,
    } : causal,
  };
}

describe('Causal Receipt Bridge', () => {
  it('keeps existing receipt output backward compatible when causal verdict is missing', () => {
    const kernel = makeKernel();
    const expected = queryTrustGraph(kernel.graph, { targetId: 'kedi', workspaceId: 'workspace-a' }).receipt;
    const receipt = buildTrustReceipt({ targetId: 'kedi', workspaceId: 'workspace-a' }, { target: kernel.graph });

    assert.deepStrictEqual(stripVolatileReceiptFields(receipt), stripVolatileReceiptFields(expected));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(receipt, 'causal'), false);
    assert.strictEqual(receipt.status, 'canonical');
  });

  it('adds causal support block without changing receipt status', () => {
    const kernel = makeKernel();
    const causalVerdict = buildCausalVerdict(traversalFixture('terminus', {
      traversalOrder: [
        {
          edgeId: 'edge-1',
          from: 'kedi',
          to: 'hayvan',
          relation: 'CAUSES',
          strength: 0.86,
          confidence: 0.91,
          depth: 1,
        },
        {
          edgeId: 'edge-2',
          from: 'hayvan',
          to: 'canli',
          relation: 'PREVENTS',
          strength: 0.25,
          confidence: 0.3,
          depth: 2,
        },
      ],
      warnings: [{ code: 'TRAVERSAL_WARN', message: 'partial' }],
    }));

    const receipt = buildTrustReceipt({
      targetId: 'kedi',
      workspaceId: 'workspace-a',
      causalVerdict,
    }, { target: kernel.graph });

    assert.strictEqual(receipt.status, 'canonical');
    assert.ok(receipt.causal);
    assert.strictEqual(receipt.causal.status, 'supports');
    assert.strictEqual(receipt.causal.bridge, 'pass');
    assert.deepStrictEqual(receipt.causal.warnings, causalVerdict.verdict.warnings);
    assert.deepStrictEqual(receipt.causal.riskFlags, causalVerdict.verdict.riskFlags);
    assert.deepStrictEqual(receipt.causal.trace, causalVerdict.verdict.trace);
    assert.strictEqual(receipt.causal.source, 'causal-verdict');
    assert.strictEqual(receipt.causal.version, '1.0.0');
    assert.strictEqual(JSON.stringify(receipt).includes('verify.status'), false);
  });

  it('maps contradiction and stop reasons into causal bridge values', () => {
    const kernel = makeKernel();

    const contradicts = buildCausalVerdict(traversalFixture('terminus', {
      root: {
        explicitContradiction: {
          reason: 'explicit_contradiction',
          confidence: 0.92,
          edges: [
            {
              edgeId: 'edge-x',
              from: 'kedi',
              to: 'canli',
              relation: 'PREVENTS',
              strength: 0.1,
              confidence: 0.2,
              depth: 1,
            },
          ],
        },
      },
    }));
    const cycleBlocked = buildCausalVerdict(traversalFixture('cycle_detected', {
      traversalOrder: [],
      visitedEdgeCount: 0,
      visitedNodeCount: 1,
      maxDepthReached: 1,
      blockedBranches: [
        {
          reason: 'cycle_detected',
          edgeId: 'edge-cycle',
          from: 'kedi',
          to: 'kedi',
          relation: 'CAUSES',
          depth: 1,
          nextDepth: 2,
          pathNodeIds: ['kedi'],
          pathEdgeIds: ['edge-cycle'],
          cycleNodeId: 'kedi',
        },
      ],
      cycleEdgeIds: ['edge-cycle'],
      cycleNodeIds: ['kedi'],
    }));
    const depthIncomplete = buildCausalVerdict(traversalFixture('depth_exceeded', {
      traversalOrder: [
        {
          edgeId: 'edge-depth',
          from: 'kedi',
          to: 'hayvan',
          relation: 'CAUSES',
          strength: 0.7,
          confidence: 0.76,
          depth: 1,
        },
      ],
      blockedBranches: [
        {
          reason: 'depth_exceeded',
          edgeId: 'edge-depth',
          from: 'kedi',
          to: 'hayvan',
          relation: 'CAUSES',
          depth: 1,
          nextDepth: 2,
          pathNodeIds: ['kedi', 'hayvan'],
          pathEdgeIds: ['edge-depth'],
          maxDepth: 1,
        },
      ],
    }));
    const inconclusive = buildCausalVerdict(traversalFixture('missing_start', {
      traversalOrder: [],
      visitedEdgeCount: 0,
      visitedNodeCount: 0,
      maxDepthReached: 0,
      warnings: [],
    }));

    const contradictoryReceipt = buildTrustReceipt({
      targetId: 'kedi',
      workspaceId: 'workspace-a',
      causalVerdict: contradicts,
    }, { target: kernel.graph });
    const cycleReceipt = buildTrustReceipt({
      targetId: 'kedi',
      workspaceId: 'workspace-a',
      causalVerdict: cycleBlocked,
    }, { target: kernel.graph });
    const depthReceipt = buildTrustReceipt({
      targetId: 'kedi',
      workspaceId: 'workspace-a',
      causalVerdict: depthIncomplete,
    }, { target: kernel.graph });
    const inconclusiveReceipt = buildTrustReceipt({
      targetId: 'kedi',
      workspaceId: 'workspace-a',
      causalVerdict: inconclusive,
    }, { target: kernel.graph });

    assert.strictEqual(contradictoryReceipt.causal.status, 'contradicts');
    assert.strictEqual(contradictoryReceipt.causal.bridge, 'fail');
    assert.strictEqual(cycleReceipt.causal.status, 'cycle_blocked');
    assert.strictEqual(cycleReceipt.causal.bridge, 'blocked');
    assert.strictEqual(depthReceipt.causal.status, 'depth_incomplete');
    assert.strictEqual(depthReceipt.causal.bridge, 'incomplete');
    assert.strictEqual(inconclusiveReceipt.causal.status, 'inconclusive');
    assert.strictEqual(inconclusiveReceipt.causal.bridge, 'not_applicable');
  });

  it('does not write audit events and remains deterministic', () => {
    const kernel = makeKernel();
    const causalVerdict = buildCausalVerdict(traversalFixture('terminus', {
      traversalOrder: [
        {
          edgeId: 'edge-1',
          from: 'kedi',
          to: 'hayvan',
          relation: 'CAUSES',
          strength: 0.8,
          confidence: 0.9,
          depth: 1,
        },
      ],
    }));

    const beforeAuditCount = kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' }).length;
    const first = buildTrustReceipt({
      targetId: 'kedi',
      workspaceId: 'workspace-a',
      causalVerdict,
    }, { target: kernel.graph });
    const afterAuditCount = kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' }).length;
    const second = buildTrustReceipt({
      targetId: 'kedi',
      workspaceId: 'workspace-a',
      causalVerdict,
    }, { target: kernel.graph });

    assert.strictEqual(beforeAuditCount, afterAuditCount);
    assert.deepStrictEqual(stripVolatileReceiptFields(first), stripVolatileReceiptFields(second));
  });
});
