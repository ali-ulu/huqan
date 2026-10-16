'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { buildHypothesisCandidate } = require('../lib/graph-hypotheses');
const { reviewHypothesisCandidate } = require('../lib/hypothesis-review');

function createCli(label) {
  const kernel = new Kernel(isolatedKernelOptions(label));
  const cli = new CLI({ kernelInstance: kernel });
  return { kernel, cli };
}

function closeCli({ kernel, cli }) {
  cli?.agent?.storage?.close?.();
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

/**
 * KRİTİK_DÜĞÜM shape: no proposedEdge. This is the candidate `--propose`
 * actually queues, because only high-severity hypotheses are proposed.
 */
function seedCriticalCandidate(kernel, workspaceId = 'default') {
  for (const id of ['a', 'b', 'c']) kernel.graph.addNode(id, id, null, { workspaceId });
  kernel.graph.addEdge('a', 'b', 'supports', { workspaceId, confidence: 0.9, evidence: ['a'] });
  kernel.graph.addEdge('c', 'b', 'supports', { workspaceId, confidence: 0.9, evidence: ['c'] });
  const candidate = buildHypothesisCandidate({
    type: 'KRİTİK_DÜĞÜM',
    severity: 'high',
    target: 'b',
    confidence: 0.9,
    gerekce: 'b düğümünün in-degree değeri 2; eşik 2.',
  }, workspaceId);
  kernel.addCandidateClaim(candidate, { workspaceId });
  return candidate;
}

/**
 * ZAYIF_BAĞ is the shape that carries a populated `proposedEdge`. Reviewing it
 * must still be a status transition only -- accept is a verdict on the
 * diagnosis, never approval to write the edge.
 */
function seedWeakEdgeCandidate(kernel, workspaceId = 'default') {
  kernel.graph.addNode('x', 'x', null, { workspaceId });
  kernel.graph.addNode('y', 'y', null, { workspaceId });
  const candidate = buildHypothesisCandidate({
    type: 'ZAYIF_BAĞ',
    severity: 'medium',
    target: 'x-[supports]->y',
    confidence: 0.1,
    edge: { from: 'x', to: 'y', relation: 'supports', confidence: 0.1, workspaceId },
    gerekce: 'x-[supports]->y confidence=0.10; eşik 0.40.',
  }, workspaceId);
  kernel.addCandidateClaim(candidate, { workspaceId });
  return candidate;
}

function readCandidate(kernel, candidateId, workspaceId = 'default') {
  return kernel.getCandidateClaims({ workspaceId }).find(item => item.candidateId === candidateId);
}

function spyCanonicalWrites(kernel) {
  const calls = [];
  const originalNode = kernel.graph.addNode.bind(kernel.graph);
  const originalEdge = kernel.graph.addEdge.bind(kernel.graph);
  kernel.graph.addNode = (...args) => { calls.push(['addNode', ...args]); return originalNode(...args); };
  kernel.graph.addEdge = (...args) => { calls.push(['addEdge', ...args]); return originalEdge(...args); };
  return calls;
}

test('--accept moves a hypothesis candidate to accepted and stamps the reviewer', async () => {
  const managed = createCli('review-accept');
  try {
    const seeded = seedCriticalCandidate(managed.kernel);
    const result = reviewHypothesisCandidate(managed.kernel, {
      candidateId: seeded.candidateId,
      decision: 'accept',
      reviewer: 'ali',
    });
    const stored = readCandidate(managed.kernel, seeded.candidateId);
    assert.equal(result.status, 'accepted');
    assert.equal(result.previousStatus, 'pending');
    assert.equal(stored.status, 'accepted');
    assert.equal(stored.reviewedBy, 'ali');
    assert.ok(stored.reviewedAt);
  } finally {
    closeCli(managed);
  }
});

test('--reject moves a hypothesis candidate to rejected and stamps the reviewer', async () => {
  const managed = createCli('review-reject');
  try {
    const seeded = seedCriticalCandidate(managed.kernel);
    reviewHypothesisCandidate(managed.kernel, {
      candidateId: seeded.candidateId,
      decision: 'reject',
      reviewer: 'ali',
    });
    const stored = readCandidate(managed.kernel, seeded.candidateId);
    assert.equal(stored.status, 'rejected');
    assert.equal(stored.reviewedBy, 'ali');
    assert.ok(stored.reviewedAt);
  } finally {
    closeCli(managed);
  }
});

test('review leaves recommendation untouched', async () => {
  const managed = createCli('review-recommendation');
  try {
    const seeded = seedCriticalCandidate(managed.kernel);
    assert.equal(readCandidate(managed.kernel, seeded.candidateId).recommendation, 'flag');
    reviewHypothesisCandidate(managed.kernel, { candidateId: seeded.candidateId, decision: 'accept' });
    assert.equal(readCandidate(managed.kernel, seeded.candidateId).recommendation, 'flag');
  } finally {
    closeCli(managed);
  }
});

test('accepting a KRİTİK_DÜĞÜM candidate writes no canonical node or edge', async () => {
  const managed = createCli('review-no-canonical-critical');
  try {
    const seeded = seedCriticalCandidate(managed.kernel);
    const calls = spyCanonicalWrites(managed.kernel);
    reviewHypothesisCandidate(managed.kernel, { candidateId: seeded.candidateId, decision: 'accept' });
    assert.deepEqual(calls, []);
  } finally {
    closeCli(managed);
  }
});

test('accepting a ZAYIF_BAĞ candidate writes no canonical node or edge despite a populated proposedEdge', async () => {
  const managed = createCli('review-no-canonical-weak');
  try {
    const seeded = seedWeakEdgeCandidate(managed.kernel);
    assert.ok(readCandidate(managed.kernel, seeded.candidateId).proposedEdge, 'fixture must carry a proposedEdge');
    const edgesBefore = managed.kernel.graph.getAllEdges('default').length;
    const calls = spyCanonicalWrites(managed.kernel);

    reviewHypothesisCandidate(managed.kernel, { candidateId: seeded.candidateId, decision: 'accept' });

    assert.deepEqual(calls, [], 'accept is a verdict on the diagnosis, not approval of the edge');
    assert.equal(managed.kernel.graph.getAllEdges('default').length, edgesBefore);
    const stored = readCandidate(managed.kernel, seeded.candidateId);
    assert.equal(stored.status, 'accepted');
    assert.deepEqual(stored.proposedEdge, seeded.proposedEdge, 'proposedEdge is preserved, never promoted');
  } finally {
    closeCli(managed);
  }
});

test('a candidate from a foreign source is refused fail-closed', async () => {
  const managed = createCli('review-foreign');
  try {
    managed.kernel.addCandidateClaim({
      candidateId: 'cand_foreign_1',
      claim: 'kediler bitkidir',
      workspaceId: 'default',
      status: 'pending',
      provenance: { provenanceId: 'prov_1', sourceType: 'manual', actor: 'ali', workspaceId: 'default' },
    }, { workspaceId: 'default' });

    assert.throws(
      () => reviewHypothesisCandidate(managed.kernel, { candidateId: 'cand_foreign_1', decision: 'accept' }),
      error => error.code === 'HYPOTHESIS_REVIEW_FOREIGN_SOURCE',
    );
    assert.equal(readCandidate(managed.kernel, 'cand_foreign_1').status, 'pending');
  } finally {
    closeCli(managed);
  }
});

test('reviewing an already reviewed candidate is refused fail-closed', async () => {
  const managed = createCli('review-double');
  try {
    const seeded = seedCriticalCandidate(managed.kernel);
    reviewHypothesisCandidate(managed.kernel, { candidateId: seeded.candidateId, decision: 'accept', reviewer: 'ali' });

    assert.throws(
      () => reviewHypothesisCandidate(managed.kernel, { candidateId: seeded.candidateId, decision: 'reject', reviewer: 'veli' }),
      error => error.code === 'HYPOTHESIS_REVIEW_ALREADY_REVIEWED',
    );
    const stored = readCandidate(managed.kernel, seeded.candidateId);
    assert.equal(stored.status, 'accepted', 'the first verdict is never silently overwritten');
    assert.equal(stored.reviewedBy, 'ali');
  } finally {
    closeCli(managed);
  }
});

test('an unknown candidate id is refused fail-closed', async () => {
  const managed = createCli('review-unknown');
  try {
    assert.throws(
      () => reviewHypothesisCandidate(managed.kernel, { candidateId: 'cand_hyp_missing', decision: 'accept' }),
      error => error.code === 'HYPOTHESIS_REVIEW_UNKNOWN_CANDIDATE',
    );
  } finally {
    closeCli(managed);
  }
});

test('an unrecognised decision is refused fail-closed', async () => {
  const managed = createCli('review-bad-decision');
  try {
    const seeded = seedCriticalCandidate(managed.kernel);
    assert.throws(
      () => reviewHypothesisCandidate(managed.kernel, { candidateId: seeded.candidateId, decision: 'maybe' }),
      error => error.code === 'HYPOTHESIS_REVIEW_INVALID_DECISION',
    );
    assert.equal(readCandidate(managed.kernel, seeded.candidateId).status, 'pending');
  } finally {
    closeCli(managed);
  }
});

test('a candidate in another workspace is not reachable', async () => {
  const managed = createCli('review-workspace');
  try {
    const seeded = seedCriticalCandidate(managed.kernel, 'alpha');
    assert.throws(
      () => reviewHypothesisCandidate(managed.kernel, {
        candidateId: seeded.candidateId,
        decision: 'accept',
        workspaceId: 'beta',
      }),
      error => error.code === 'HYPOTHESIS_REVIEW_UNKNOWN_CANDIDATE',
    );
    assert.equal(readCandidate(managed.kernel, seeded.candidateId, 'alpha').status, 'pending');
  } finally {
    closeCli(managed);
  }
});

test('review appends a CLAIM_ACCEPTED / CLAIM_REJECTED audit event', async () => {
  const managed = createCli('review-audit');
  try {
    const accepted = seedCriticalCandidate(managed.kernel);
    reviewHypothesisCandidate(managed.kernel, { candidateId: accepted.candidateId, decision: 'accept', reviewer: 'ali' });

    const events = managed.kernel.graph.getAuditEvents({ workspaceId: 'default' })
      .filter(event => event.targetId === accepted.candidateId);
    const event = events.find(item => item.eventType === 'CLAIM_ACCEPTED');
    assert.ok(event, 'an accept must leave a CLAIM_ACCEPTED trail');
    assert.equal(event.targetType, 'candidate_claim');
    assert.equal(event.details.reviewedBy, 'ali');
    assert.equal(event.details.previousStatus, 'pending');
    assert.equal(event.details.canonicalWrite, false);
  } finally {
    closeCli(managed);
  }
});

test('hypotheses review is reachable from the CLI and emits a JSON workflow envelope', async () => {
  const managed = createCli('review-cli');
  try {
    const seeded = seedCriticalCandidate(managed.kernel);
    const stdout = [];
    const result = await runCliArgv(['hypotheses', 'review', seeded.candidateId, '--reject', '--json'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.workflowId, 'hypotheses');
    assert.equal(envelope.status, 'completed');
    assert.equal(envelope.data.review.status, 'rejected');
    assert.equal(readCandidate(managed.kernel, seeded.candidateId).status, 'rejected');
  } finally {
    closeCli(managed);
  }
});

test('hypotheses review records a CLI mutation audit entry', async () => {
  const managed = createCli('review-cli-audit');
  try {
    const seeded = seedCriticalCandidate(managed.kernel);
    await runCliArgv(['hypotheses', 'review', seeded.candidateId, '--accept', '--json'], {
      cli: managed.cli,
      stdout: () => {},
    });
    const events = managed.kernel.graph.getAuditEvents({ workspaceId: 'default' });
    assert.ok(
      events.some(event => JSON.stringify(event.details || {}).includes('cli_hypothesis_proposal')),
      'the review write goes through the same CLI mutation gate as --propose',
    );
  } finally {
    closeCli(managed);
  }
});
