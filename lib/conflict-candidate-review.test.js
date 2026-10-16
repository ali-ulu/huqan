const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const { routeCandidateClaim } = require('./conflict-detector');
const { readClaim } = require('./claim-read');
const { READ_BEHAVIORS } = require('./contested-read-policy');
const { DECISIONS, isConflictCandidate, reviewConflictCandidate } = require('./conflict-candidate-review');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-conflict-review-'));

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeProvenance(overrides = {}) {
  return {
    provenanceId: 'prov-edge-001',
    sourceRef: 'docs/claims.md#1',
    sourceTitle: 'Claims',
    sourceType: 'document',
    actor: 'builder',
    timestamp: '2026-06-02T00:00:00Z',
    confidence: 0.91,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '0.8.0',
    ...overrides,
  };
}

function routeKernelCandidate(kernel, claim, opts = {}) {
  const admissionOwner = kernel.kernel || kernel;
  return routeCandidateClaim(kernel, claim, opts, {
    evaluateLearnAdmission: (text, admissionOpts, provenance, workspaceId) =>
      admissionOwner._evaluateLearnAdmission(text, admissionOpts, provenance, workspaceId),
  });
}

/** Real contested state via a real Kernel, mirroring lib/claim-read.test.js's fixture. */
function buildContestedKernel(name) {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, `${name}.json`) });
  const edgeProvenance = makeProvenance();
  kernel.graph.addNode('fire', 'fire', edgeProvenance, { workspaceId: 'workspace-a' });
  kernel.graph.addNode('smoke', 'smoke', edgeProvenance, { workspaceId: 'workspace-a' });
  kernel.graph.addEdge('fire', 'smoke', 'CAUSES', {
    workspaceId: 'workspace-a',
    provenance: edgeProvenance,
    strength: 0.9,
    confidence: 0.88,
    source: 'manual',
    sourceRef: edgeProvenance.sourceRef,
    evidence: ['fire causes smoke'],
  });

  const routed = routeKernelCandidate(kernel, {
    claim: 'fire prevents smoke',
    subject: 'fire',
    relation: 'PREVENTS',
    object: 'smoke',
    provenance: makeProvenance({ provenanceId: 'prov-challenge-001', sourceRef: 'docs/claims.md#2' }),
  }, { workspaceId: 'workspace-a' });

  assert.strictEqual(routed.conflict.conflict, true, 'setup: candidate must actually conflict');
  assert.strictEqual(routed.candidate.status, 'pending', 'setup: candidate must be unreviewed');

  return { kernel, candidateId: routed.candidate.candidateId };
}

test('isConflictCandidate is true only for a candidate carrying a detected conflict', () => {
  assert.strictEqual(isConflictCandidate({ conflict: { conflict: true } }), true);
  assert.strictEqual(isConflictCandidate({ conflict: { conflict: false } }), false);
  assert.strictEqual(isConflictCandidate({ conflict: null }), false);
  assert.strictEqual(isConflictCandidate({}), false);
  assert.strictEqual(isConflictCandidate(null), false);
});

function throwsWithCode(code) {
  return (error) => error instanceof Error && error.code === code;
}

test('reviewConflictCandidate rejects an unknown candidateId', () => {
  const { kernel } = buildContestedKernel('unknown-id');
  assert.throws(
    () => reviewConflictCandidate(kernel, { candidateId: 'does-not-exist', decision: 'accept', workspaceId: 'workspace-a' }),
    throwsWithCode('CONFLICT_REVIEW_UNKNOWN_CANDIDATE'),
  );
});

test('reviewConflictCandidate rejects a missing candidateId', () => {
  const { kernel } = buildContestedKernel('missing-id');
  assert.throws(
    () => reviewConflictCandidate(kernel, { decision: 'accept', workspaceId: 'workspace-a' }),
    throwsWithCode('CONFLICT_REVIEW_UNKNOWN_CANDIDATE'),
  );
});

test('reviewConflictCandidate rejects an unrecognised decision', () => {
  const { kernel, candidateId } = buildContestedKernel('bad-decision');
  assert.throws(
    () => reviewConflictCandidate(kernel, { candidateId, decision: 'maybe', workspaceId: 'workspace-a' }),
    throwsWithCode('CONFLICT_REVIEW_INVALID_DECISION'),
  );
});

test('reviewConflictCandidate refuses a candidate with no detected conflict', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, 'non-conflict.json') });
  kernel.addCandidateClaim({
    candidateId: 'cand-non-conflict-1',
    claim: 'this is a hypothesis, not a conflict',
    recommendation: 'flag',
    conflict: null,
    status: 'pending',
    provenance: makeProvenance(),
  }, { workspaceId: 'workspace-a' });

  assert.throws(
    () => reviewConflictCandidate(kernel, { candidateId: 'cand-non-conflict-1', decision: 'accept', workspaceId: 'workspace-a' }),
    throwsWithCode('CONFLICT_REVIEW_NOT_A_CONFLICT'),
  );
});

test('reviewConflictCandidate refuses to silently overwrite an already-reviewed candidate', () => {
  const { kernel, candidateId } = buildContestedKernel('double-review');
  reviewConflictCandidate(kernel, { candidateId, decision: 'accept', workspaceId: 'workspace-a' });
  assert.throws(
    () => reviewConflictCandidate(kernel, { candidateId, decision: 'reject', workspaceId: 'workspace-a' }),
    throwsWithCode('CONFLICT_REVIEW_ALREADY_REVIEWED'),
  );
});

test('reviewConflictCandidate accept: records a verdict, writes no canonical edge, matches DECISIONS contract', () => {
  const { kernel, candidateId } = buildContestedKernel('accept-verdict');
  const before = kernel.graph.getEdgesBetween ? kernel.graph.getEdgesBetween('fire', 'smoke', 'workspace-a') : [];

  const review = reviewConflictCandidate(kernel, {
    candidateId,
    decision: 'accept',
    reviewer: 'ali',
    workspaceId: 'workspace-a',
  });

  assert.strictEqual(review.status, DECISIONS.accept);
  assert.strictEqual(review.previousStatus, 'pending');
  assert.strictEqual(review.reviewedBy, 'ali');
  assert.strictEqual(review.canonicalWrite, false);
  assert.strictEqual(review.conflictType, 'agent-vs-causal', 'CAUSES/PREVENTS are both causal relations, so conflict-detector classifies this as agent-vs-causal');

  const after = kernel.graph.getEdgesBetween ? kernel.graph.getEdgesBetween('fire', 'smoke', 'workspace-a') : [];
  assert.strictEqual(after.length, before.length, 'accepting a conflict verdict must not write a canonical edge');

  const stored = kernel.getCandidateClaims({ workspaceId: 'workspace-a' }).find(c => c.candidateId === candidateId);
  assert.strictEqual(stored.status, 'accepted');
  assert.strictEqual(stored.recommendation, 'flag', 'the engine recommendation is a separate fact from the verdict');
});

test('reviewConflictCandidate reject: records a verdict, writes no canonical edge', () => {
  const { kernel, candidateId } = buildContestedKernel('reject-verdict');

  const review = reviewConflictCandidate(kernel, { candidateId, decision: 'reject', workspaceId: 'workspace-a' });

  assert.strictEqual(review.status, DECISIONS.reject);
  assert.strictEqual(review.canonicalWrite, false);
  assert.strictEqual(review.reviewedBy, 'cli:conflict-review', 'default reviewer when none is given');

  const stored = kernel.getCandidateClaims({ workspaceId: 'workspace-a' }).find(c => c.candidateId === candidateId);
  assert.strictEqual(stored.status, 'rejected');
});

test('end-to-end: a HIGH-risk block clears after the conflict candidate is accepted', () => {
  const { kernel, candidateId } = buildContestedKernel('e2e-accept');
  const intent = { category: 'CANONICAL_GRAPH_WRITE' };

  const blocked = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent });
  assert.strictEqual(blocked.kind, 'unsettled');
  assert.strictEqual(blocked.behavior, READ_BEHAVIORS.BLOCK);

  reviewConflictCandidate(kernel, { candidateId, decision: 'accept', workspaceId: 'workspace-a' });

  const settled = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent });
  assert.strictEqual(settled.kind, 'settled');
  assert.strictEqual(settled.value.targetId, 'fire');
});

test('end-to-end: a HIGH-risk block clears after the conflict candidate is rejected', () => {
  const { kernel, candidateId } = buildContestedKernel('e2e-reject');
  const intent = { category: 'CANONICAL_GRAPH_WRITE' };

  const blocked = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent });
  assert.strictEqual(blocked.kind, 'unsettled');
  assert.strictEqual(blocked.behavior, READ_BEHAVIORS.BLOCK);

  reviewConflictCandidate(kernel, { candidateId, decision: 'reject', workspaceId: 'workspace-a' });

  const settled = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent });
  assert.strictEqual(settled.kind, 'settled');
  assert.strictEqual(settled.value.targetId, 'fire');
});
