const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const Graph = require('../graph');
const {
  buildTrustReceipt,
  queryAuditTrail,
  queryCandidateClaims,
  queryProvenance,
  queryTrustGraph,
} = require('./provenance-query');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-trust-query-'));

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

const APPROVED_TEST_ADMISSION = {
  admissionRequired: true,
  approvalRequired: true,
  approvalStatus: 'approved',
  approvalId: 'apr-provenance-query-test',
};

describe('Provenance Query', () => {
  it('builds a canonical trust receipt with provenance metadata', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, 'canonical.json') });
    const provenance = makeProvenance();

    kernel.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });

    const receipt = buildTrustReceipt({ targetId: 'kedi', workspaceId: 'workspace-a' }, { target: kernel.graph });

    assert.ok(receipt.receiptId);
    assert.ok(receipt.generatedAt);
    assert.strictEqual(receipt.workspaceId, 'workspace-a');
    assert.strictEqual(receipt.status, 'canonical');
    assert.strictEqual(receipt.canonical, true);
    assert.ok(receipt.provenance);
    assert.strictEqual(receipt.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(receipt.provenance.sourceRef, provenance.sourceRef);
    assert.strictEqual(receipt.provenance.sourceType, 'document');
    assert.strictEqual(receipt.trustPolicyVersion, '0.8.0');
    assert.strictEqual(receipt.confidence, 0.88);
  });

  it('maps candidate claims to pending, flagged and rejected receipts', () => {
    const graph = new Graph({
      memoryPath: path.join(tempDir, 'candidate.json'),
      useSQLite: false,
    });

    const pending = makeProvenance({ provenanceId: 'prov-pending', sourceRef: 'github://owner/repo/pull/1' });
    const flagged = makeProvenance({ provenanceId: 'prov-flagged', sourceRef: 'github://owner/repo/pull/2' });
    const rejected = makeProvenance({ provenanceId: 'prov-rejected', sourceRef: 'github://owner/repo/pull/3' });

    graph.addCandidateClaim({
      candidateId: 'cand-pending',
      workspaceId: 'workspace-a',
      claim: 'kedi hayvandir',
      proposedEdge: { from: 'kedi', relation: 'tür', to: 'hayvan', confidence: 0.62, workspaceId: 'workspace-a' },
      provenance: pending,
      recommendation: 'accept',
      status: 'pending',
      createdAt: '2026-06-02T00:00:00Z',
    });
    graph.addCandidateClaim({
      candidateId: 'cand-flagged',
      workspaceId: 'workspace-a',
      claim: 'kedi memelidir',
      proposedEdge: { from: 'kedi', relation: 'tür', to: 'memeli', confidence: 0.22, workspaceId: 'workspace-a' },
      provenance: flagged,
      recommendation: 'flag',
      status: 'flagged',
      createdAt: '2026-06-02T00:01:00Z',
      conflict: { reason: 'low confidence' },
    });
    graph.addCandidateClaim({
      candidateId: 'cand-rejected',
      workspaceId: 'workspace-a',
      claim: 'kedi bitkidir',
      proposedEdge: { from: 'kedi', relation: 'tür', to: 'bitki', confidence: 0.05, workspaceId: 'workspace-a' },
      provenance: rejected,
      recommendation: 'reject',
      status: 'rejected',
      createdAt: '2026-06-02T00:02:00Z',
      conflict: { reason: 'contradiction' },
    });

    const pendingReceipt = buildTrustReceipt({ candidateId: 'cand-pending', workspaceId: 'workspace-a' }, { target: graph });
    const flaggedReceipt = buildTrustReceipt({ candidateId: 'cand-flagged', workspaceId: 'workspace-a' }, { target: graph });
    const rejectedReceipt = buildTrustReceipt({ candidateId: 'cand-rejected', workspaceId: 'workspace-a' }, { target: graph });
    const unknownReceipt = buildTrustReceipt({ targetId: 'missing', workspaceId: 'workspace-a' }, { target: graph });

    assert.strictEqual(pendingReceipt.status, 'pending');
    assert.strictEqual(flaggedReceipt.status, 'flagged');
    assert.strictEqual(rejectedReceipt.status, 'rejected');
    assert.strictEqual(unknownReceipt.status, 'unknown');
    assert.strictEqual(pendingReceipt.candidateClaim.candidateId, 'cand-pending');
    assert.strictEqual(flaggedReceipt.candidateClaim.candidateId, 'cand-flagged');
    assert.strictEqual(rejectedReceipt.candidateClaim.candidateId, 'cand-rejected');
    assert.strictEqual(flaggedReceipt.conflict.reason, 'low confidence');
    assert.strictEqual(rejectedReceipt.conflict.reason, 'contradiction');
  });

  it('shadowed canonical records are not surfaced as canonical trust receipts', () => {
    const graph = new Graph({
      memoryPath: path.join(tempDir, 'shadowed.json'),
      useSQLite: false,
    });

    const provenance = makeProvenance({ provenanceId: 'prov-shadowed', sourceRef: 'docs/shadowed.md#claim' });

    graph.addNode('kedi', 'kedi hayvandir', provenance, { workspaceId: 'workspace-a' });
    graph.addCandidateClaim({
      candidateId: 'cand-shadow',
      workspaceId: 'workspace-a',
      claim: 'kedi hayvandir',
      proposedEdge: { from: 'kedi', relation: 'tür', to: 'hayvan', confidence: 0.4, workspaceId: 'workspace-a' },
      provenance,
      recommendation: 'flag',
      status: 'flagged',
      createdAt: '2026-06-02T00:00:00Z',
      conflict: { reason: 'shadowed canonical record' },
    });

    const receipt = buildTrustReceipt({ targetId: 'kedi', workspaceId: 'workspace-a' }, { target: graph });

    assert.strictEqual(receipt.status, 'flagged');
    assert.strictEqual(receipt.canonical, false);
    assert.strictEqual(receipt.targetType, 'candidate_claim');
    assert.strictEqual(receipt.targetId, 'cand-shadow');
    assert.strictEqual(receipt.claim, 'kedi hayvandir');
    assert.ok(receipt.candidateClaim);
    assert.strictEqual(receipt.candidateClaim.candidateId, 'cand-shadow');
  });

  it('queries provenance, audit trails and candidate claims with workspace isolation', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, 'query.json') });
    const provenanceA = makeProvenance();
    const provenanceB = makeProvenance({
      provenanceId: 'prov-workspace-b',
      sourceRef: 'docs/claim.md#2',
      sourceType: 'github',
      workspaceId: 'workspace-b',
    });

    kernel.learn('kedi hayvandir', { provenance: provenanceA, ...APPROVED_TEST_ADMISSION });
    kernel.graph.addCandidateClaim({
      candidateId: 'cand-a',
      workspaceId: 'workspace-a',
      claim: 'kedi hayvandir',
      proposedEdge: { from: 'kedi', relation: 'tür', to: 'hayvan', confidence: 0.6, workspaceId: 'workspace-a' },
      provenance: provenanceA,
      recommendation: 'accept',
      status: 'pending',
      createdAt: '2026-06-02T00:00:00Z',
    });
    kernel.graph.addCandidateClaim({
      candidateId: 'cand-b',
      workspaceId: 'workspace-b',
      claim: 'kedi memelidir',
      proposedEdge: { from: 'kedi', relation: 'tür', to: 'memeli', confidence: 0.2, workspaceId: 'workspace-b' },
      provenance: provenanceB,
      recommendation: 'flag',
      status: 'flagged',
      createdAt: '2026-06-02T00:01:00Z',
    });
    kernel.graph.appendAuditEvent({
      auditId: 'audit-1',
      eventType: 'LEARN',
      targetType: 'edge',
      targetId: 'kedi|tür|hayvan',
      workspaceId: 'workspace-a',
      actor: 'builder',
      timestamp: '2026-06-02T00:00:00Z',
      sourceRef: provenanceA.sourceRef,
      provenanceId: provenanceA.provenanceId,
      trustPolicyVersion: provenanceA.trustPolicyVersion,
      details: { source: 'test' },
    }, { provenance: provenanceA });
    kernel.graph.appendAuditEvent({
      auditId: 'audit-2',
      eventType: 'QUERY',
      targetType: 'graph',
      targetId: 'kedi',
      workspaceId: 'workspace-a',
      actor: 'builder',
      timestamp: '2026-06-02T00:05:00Z',
      sourceRef: provenanceA.sourceRef,
      provenanceId: provenanceA.provenanceId,
      trustPolicyVersion: provenanceA.trustPolicyVersion,
      details: { source: 'test-2' },
    }, { provenance: provenanceA });

    const provenanceHits = queryProvenance(kernel.graph, {
      provenanceId: provenanceA.provenanceId,
      workspaceId: 'workspace-a',
    });
    const sourceHits = queryProvenance(kernel.graph, {
      sourceRef: provenanceA.sourceRef,
      workspaceId: 'workspace-a',
    });
    const sourceTypeHits = queryProvenance(kernel.graph, {
      sourceType: 'document',
      workspaceId: 'workspace-a',
    });
    const auditHits = queryAuditTrail(kernel.graph, {
      sourceRef: provenanceA.sourceRef,
      workspaceId: 'workspace-a',
    });
    const auditByType = queryAuditTrail(kernel.graph, {
      eventType: 'QUERY',
      workspaceId: 'workspace-a',
    });
    const candidateHits = queryCandidateClaims(kernel.graph, {
      status: 'pending',
      workspaceId: 'workspace-a',
    });
    const candidateByRecommendation = queryCandidateClaims(kernel.graph, {
      recommendation: 'accept',
      workspaceId: 'workspace-a',
    });
    const candidateBySource = queryCandidateClaims(kernel.graph, {
      sourceRef: provenanceA.sourceRef,
      workspaceId: 'workspace-a',
    });
    const workspaceScoped = queryCandidateClaims(kernel.graph, {
      workspaceId: 'workspace-a',
    });
    const trustGraph = queryTrustGraph(kernel.graph, {
      targetId: 'kedi',
      workspaceId: 'workspace-a',
    });

    assert.ok(provenanceHits.length >= 1);
    assert.ok(sourceHits.length >= 1);
    assert.ok(sourceTypeHits.length >= 1);
    assert.strictEqual(provenanceHits[0].provenance.provenanceId, provenanceA.provenanceId);
    assert.strictEqual(sourceHits[0].provenance.sourceRef, provenanceA.sourceRef);
    assert.strictEqual(sourceTypeHits[0].provenance.sourceType, 'document');
    assert.ok(auditHits.length >= 1);
    assert.strictEqual(auditHits[0].sourceRef, provenanceA.sourceRef);
    assert.strictEqual(auditHits[0].timestamp, '2026-06-02T00:00:00Z');
    assert.ok(auditByType.length >= 1);
    assert.strictEqual(auditByType[0].eventType, 'QUERY');
    assert.ok(candidateHits.length >= 1);
    assert.ok(candidateByRecommendation.length >= 1);
    assert.ok(candidateBySource.length >= 1);
    assert.ok(workspaceScoped.every((candidate) => candidate.workspaceId === 'workspace-a'));
    assert.strictEqual(workspaceScoped.some((candidate) => candidate.workspaceId === 'workspace-b'), false);
    assert.strictEqual(trustGraph.receipt.status, 'pending');
    assert.strictEqual(trustGraph.receipt.canonical, false);
    assert.ok(Array.isArray(trustGraph.auditTrail));
    assert.ok(Array.isArray(trustGraph.candidateClaims));
    assert.ok(trustGraph.auditTrail.length >= 1);
    assert.ok(trustGraph.candidateClaims.length >= 1);
  });
});
