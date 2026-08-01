'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');
const Graph = require('../graph');
const { queueReviewedExternalIngest } = require('../lib/external-ingest-queue');
const { prepareReviewedExternalExecution } = require('../lib/reviewed-external-execution');
const { materializeReviewedExternalIngestBatch } = require('../lib/reviewed-external-ingest-batch');
const { buildReviewedExternalCandidatePlan } = require('../lib/reviewed-external-ingest-candidates');
const { admitReviewedExternalCandidatePlan } = require('../lib/reviewed-external-admission');
const { reserveReviewedExternalAdmission } = require('../lib/reviewed-external-admission-reservation');
const {
  REVIEWED_EXTERNAL_GRAPH_RESULT_VERSION,
  REVIEWED_EXTERNAL_GRAPH_RECEIPT_VERSION,
  REVIEWED_EXTERNAL_GRAPH_FINALIZATION_VERSION,
  executeReviewedExternalGraphMutation,
} = require('../lib/reviewed-external-graph-execution');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function createFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-reviewed-graph-${name}-`));
  fs.mkdirSync(path.join(root, 'docs'));
  const sourcePath = path.join(root, 'docs', 'claim.md');
  fs.writeFileSync(sourcePath, '# Claim\nReviewed exact-once graph bytes.\n', 'utf8');
  const store = new AxiomStorage({
    memoryPath: path.join(root, 'approval-memory.json'),
    dbPath: path.join(root, 'approval-memory.db'),
  });
  const graph = new Graph({
    memoryPath: path.join(root, 'graph-memory.json'),
    dbPath: path.join(root, 'graph-memory.db'),
    useSQLite: true,
  });
  return {
    root,
    sourcePath,
    store,
    graph,
    close() {
      graph.close();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function batchOptions(plan, now) {
  return {
    now,
    approvalId: plan.approvalId,
    requester: plan.requester,
    workspaceId: plan.workspaceId,
    reviewer: plan.reviewer,
    leaseOwner: plan.leaseOwner,
  };
}

function candidateOptions(batch, now) {
  return {
    now,
    approvalId: batch.approvalId,
    approvalKey: batch.approvalKey,
    snapshotHash: batch.snapshotHash,
    reviewedManifestHash: batch.reviewedManifestHash,
    executionPlanHash: batch.executionPlanHash,
    batchHash: batch.batchHash,
    sourceType: batch.sourceType,
    sourceRef: batch.sourceRef,
    immutableSourceId: batch.immutableSourceId,
    workspaceId: batch.workspaceId,
    requester: batch.requester,
    reviewer: batch.reviewer,
    leaseOwner: batch.leaseOwner,
  };
}

function admissionOptions(plan, approvalStore, now) {
  return {
    approvalStore,
    now,
    approvalId: plan.approvalId,
    approvalKey: plan.approvalKey,
    snapshotHash: plan.snapshotHash,
    reviewedManifestHash: plan.reviewedManifestHash,
    executionPlanHash: plan.executionPlanHash,
    batchHash: plan.batchHash,
    candidatePlanHash: plan.candidatePlanHash,
    sourceType: plan.sourceType,
    sourceRef: plan.sourceRef,
    immutableSourceId: plan.immutableSourceId,
    workspaceId: plan.workspaceId,
    requester: plan.requester,
    reviewer: plan.reviewer,
    leaseOwner: plan.leaseOwner,
  };
}

function reservationOptions(admission, approvalStore, now) {
  return {
    approvalStore,
    now,
    approvalId: admission.approvalId,
    approvalKey: admission.approvalKey,
    snapshotHash: admission.snapshotHash,
    reviewedManifestHash: admission.reviewedManifestHash,
    executionPlanHash: admission.executionPlanHash,
    batchHash: admission.batchHash,
    candidatePlanHash: admission.candidatePlanHash,
    admissionHash: admission.admissionHash,
    approvalRecordHash: admission.approvalRecordHash,
    sourceType: admission.sourceType,
    sourceRef: admission.sourceRef,
    immutableSourceId: admission.immutableSourceId,
    workspaceId: admission.workspaceId,
    requester: admission.requester,
    reviewer: admission.reviewer,
    leaseOwner: admission.leaseOwner,
  };
}

function executionOptions(plan, reservation, approvalStore, graph, now) {
  return {
    approvalStore,
    graph,
    now,
    approvalId: plan.approvalId,
    approvalKey: plan.approvalKey,
    reservationHash: reservation.reservationHash,
    admissionHash: reservation.admissionHash,
    candidatePlanHash: plan.candidatePlanHash,
    workspaceId: plan.workspaceId,
    leaseOwner: plan.leaseOwner,
    sourceRef: plan.sourceRef,
    immutableSourceId: plan.immutableSourceId,
  };
}

async function buildReservedExecution(fixture, idempotencyKey) {
  const queued = await queueReviewedExternalIngest(fixture.store, {
    sourceType: 'markdown',
    rootPath: '/caller-root-must-be-ignored',
    path: 'docs/claim.md',
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey,
  }, {
    now: new Date(),
    markdownRootPath: fixture.root,
  });
  assert.equal(queued.ok, true);

  const claimed = fixture.store.claimToolApprovalWithLease(queued.approval.id, {
    owner: 'worker:1',
    leaseMs: 300_000,
    reason: 'reviewed_external_graph_claimed',
  });
  assert.equal(claimed.claimed, true);
  const claim = claimed.approval.context.executionClaim;
  const preparedAt = new Date(Number(claim.claimedAt) + 10);
  const admittedAt = new Date(preparedAt.getTime() + 1_000);
  const reservedAt = new Date(admittedAt.getTime() + 1_000);
  const executedAt = new Date(reservedAt.getTime() + 1_000);

  const prepared = prepareReviewedExternalExecution(claimed.approval, {
    now: preparedAt,
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    reviewer: 'user:bob',
    leaseOwner: 'worker:1',
  });
  assert.equal(prepared.ok, true);

  const batch = materializeReviewedExternalIngestBatch(
    prepared.plan,
    batchOptions(prepared.plan, preparedAt),
  );
  assert.equal(batch.ok, true);

  const candidate = buildReviewedExternalCandidatePlan(
    batch.batch,
    candidateOptions(batch.batch, preparedAt),
  );
  assert.equal(candidate.ok, true);

  const admitted = admitReviewedExternalCandidatePlan(
    candidate.plan,
    admissionOptions(candidate.plan, fixture.store, admittedAt),
  );
  assert.equal(admitted.ok, true);

  const reserved = reserveReviewedExternalAdmission(
    admitted.admission,
    reservationOptions(admitted.admission, fixture.store, reservedAt),
  );
  assert.equal(reserved.ok, true);

  return {
    approvalId: queued.approval.id,
    plan: candidate.plan,
    reservation: reserved.reservation,
    executedAt,
  };
}

function graphOperationId(reservation) {
  return `reviewed-external-graph:${reservation.reservationHash.slice('sha256:'.length)}`;
}

function graphCounts(graph, workspaceId) {
  return {
    nodes: Object.keys(graph.getNodes(workspaceId)).length,
    edges: graph.getStats().edges,
  };
}

test('real SQLite graph mutation commits once, finalizes approval and replays without duplicate writes', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture('success');
  try {
    const built = await buildReservedExecution(fixture, 'graph-success');
    fs.unlinkSync(fixture.sourcePath);

    const first = executeReviewedExternalGraphMutation(
      built.plan,
      built.reservation,
      executionOptions(built.plan, built.reservation, fixture.store, fixture.graph, built.executedAt),
    );
    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    assert.equal(first.result.version, REVIEWED_EXTERNAL_GRAPH_RESULT_VERSION);
    assert.equal(first.result.nodeCount, 3);
    assert.equal(first.result.edgeCount, 2);
    assert.equal(first.result.candidateCount, built.plan.candidateCount);
    assert.equal(first.receipt.canonicalPayload.version, REVIEWED_EXTERNAL_GRAPH_RECEIPT_VERSION);
    assert.equal(first.receipt.canonicalPayload.reservationHash, built.reservation.reservationHash);

    const approved = fixture.store.getToolApprovalById(built.approvalId);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decision, 'approved');
    assert.equal(approved.reason, 'reviewed_external_graph_committed');
    assert.equal(approved.decided_at, approved.updated_at);
    assert.equal(
      approved.context.reviewedExternalGraphFinalization.version,
      REVIEWED_EXTERNAL_GRAPH_FINALIZATION_VERSION,
    );

    const beforeReplay = graphCounts(fixture.graph, built.plan.workspaceId);
    const replay = executeReviewedExternalGraphMutation(
      built.plan,
      built.reservation,
      executionOptions(
        built.plan,
        built.reservation,
        fixture.store,
        fixture.graph,
        new Date(built.executedAt.getTime() + 1_000),
      ),
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.deepEqual(graphCounts(fixture.graph, built.plan.workspaceId), beforeReplay);
    assert.equal(
      fixture.graph.getCommittedMutationReceiptByOperation(graphOperationId(built.reservation)).receiptHash,
      first.receipt.receiptHash,
    );
  } finally {
    fixture.close();
  }
});

test('JSON graph backend is rejected before approval claim persistence or graph mutation', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture('json-backend');
  const jsonGraph = new Graph({ useSQLite: false });
  try {
    const built = await buildReservedExecution(fixture, 'graph-json-backend');
    const before = fixture.store.getToolApprovalById(built.approvalId);

    const result = executeReviewedExternalGraphMutation(
      built.plan,
      built.reservation,
      executionOptions(built.plan, built.reservation, fixture.store, jsonGraph, built.executedAt),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REVIEWED_GRAPH_BACKEND_REQUIRED');

    const after = fixture.store.getToolApprovalById(built.approvalId);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(Object.hasOwn(after.context, 'reviewedExternalGraphExecution'), false);
    assert.equal(jsonGraph.getStats().nodes, 0);
    assert.equal(jsonGraph.getStats().edges, 0);
  } finally {
    jsonGraph.close();
    fixture.close();
  }
});

test('stale claim readback fails closed before graph mutation and a clean retry recovers', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture('claim-readback');
  try {
    const built = await buildReservedExecution(fixture, 'graph-claim-readback');
    const stale = fixture.store.getToolApprovalById(built.approvalId);
    let reads = 0;
    const staleReadbackStore = {
      db: fixture.store.db,
      getToolApprovalById(id) {
        reads += 1;
        if (reads === 2) return structuredClone(stale);
        return fixture.store.getToolApprovalById(id);
      },
    };

    const failed = executeReviewedExternalGraphMutation(
      built.plan,
      built.reservation,
      executionOptions(built.plan, built.reservation, staleReadbackStore, fixture.graph, built.executedAt),
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'REVIEWED_GRAPH_EXECUTION_CLAIM_READBACK_INVALID');
    assert.equal(fixture.graph.getStats().nodes, 0);
    assert.equal(fixture.graph.getStats().edges, 0);
    assert.equal(
      fixture.graph.getCommittedMutationReceiptByOperation(graphOperationId(built.reservation)),
      null,
    );

    const claimed = fixture.store.getToolApprovalById(built.approvalId);
    assert.equal(claimed.status, 'executing');
    assert.equal(Object.hasOwn(claimed.context, 'reviewedExternalGraphExecution'), true);

    const recovered = executeReviewedExternalGraphMutation(
      built.plan,
      built.reservation,
      executionOptions(
        built.plan,
        built.reservation,
        fixture.store,
        fixture.graph,
        new Date(built.executedAt.getTime() + 1_000),
      ),
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.replayed, false);
    assert.equal(fixture.store.getToolApprovalById(built.approvalId).status, 'approved');
  } finally {
    fixture.close();
  }
});

test('finalization CAS loss preserves one durable graph commit and retry only finalizes', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture('finalization-race');
  try {
    const built = await buildReservedExecution(fixture, 'graph-finalization-race');
    const finalizationRaceStore = {
      getToolApprovalById(id) {
        return fixture.store.getToolApprovalById(id);
      },
      db: {
        prepare(sql) {
          if (/SET status='approved'/u.test(sql)) {
            return { run() { return { changes: 0 }; } };
          }
          return fixture.store.db.prepare(sql);
        },
      },
    };

    const failed = executeReviewedExternalGraphMutation(
      built.plan,
      built.reservation,
      executionOptions(built.plan, built.reservation, finalizationRaceStore, fixture.graph, built.executedAt),
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'REVIEWED_GRAPH_FINALIZATION_CAS_FAILED');

    const receipt = fixture.graph.getCommittedMutationReceiptByOperation(
      graphOperationId(built.reservation),
    );
    assert.ok(receipt);
    const beforeRetry = graphCounts(fixture.graph, built.plan.workspaceId);
    const pending = fixture.store.getToolApprovalById(built.approvalId);
    assert.equal(pending.status, 'executing');
    assert.equal(Object.hasOwn(pending.context, 'reviewedExternalGraphFinalization'), false);

    const recovered = executeReviewedExternalGraphMutation(
      built.plan,
      built.reservation,
      executionOptions(
        built.plan,
        built.reservation,
        fixture.store,
        fixture.graph,
        new Date(built.executedAt.getTime() + 1_000),
      ),
    );
    assert.equal(recovered.ok, true);
    assert.deepEqual(graphCounts(fixture.graph, built.plan.workspaceId), beforeRetry);
    assert.equal(
      fixture.graph.getCommittedMutationReceiptByOperation(graphOperationId(built.reservation)).receiptHash,
      receipt.receiptHash,
    );
    assert.equal(fixture.store.getToolApprovalById(built.approvalId).status, 'approved');
  } finally {
    fixture.close();
  }
});

test('graph execution module stays bounded to approval CAS and durable graph primitives', () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'reviewed-external-graph-execution.js'),
    'utf8',
  );
  assert.doesNotMatch(moduleSource, /require\(['"](?:fs|node:fs|https?|node:https?|child_process|node:child_process)['"]\)/u);
  assert.doesNotMatch(moduleSource, /\bfetch\s*\(/u);
  assert.match(moduleSource, /runMutationOnce/u);
  assert.match(moduleSource, /UPDATE tool_approvals/u);
  assert.doesNotMatch(moduleSource, /\b(?:INSERT|DELETE)\s+(?:INTO|FROM)\s+tool_approvals/iu);
  assert.doesNotMatch(moduleSource, /\.(?:claimToolApproval|renewToolApprovalLease|resolveToolApproval|failToolApproval)\s*\(/u);
});
