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
const { executeReviewedExternalGraphMutation } = require('../lib/reviewed-external-graph-execution');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function createFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-reviewed-graph-integrity-${name}-`));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'claim.md'), '# Claim\nReceipt integrity bytes.\n', 'utf8');
  const store = new AxiomStorage({
    memoryPath: path.join(root, 'approval.json'),
    dbPath: path.join(root, 'approval.db'),
  });
  const graph = new Graph({
    memoryPath: path.join(root, 'graph.json'),
    dbPath: path.join(root, 'graph.db'),
    useSQLite: true,
  });
  return {
    root,
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

function admissionOptions(plan, store, now) {
  return {
    approvalStore: store,
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

function reservationOptions(admission, store, now) {
  return {
    approvalStore: store,
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

function executionOptions(plan, reservation, store, graph, now) {
  return {
    approvalStore: store,
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

async function buildReserved(fixture, idempotencyKey) {
  const queued = await queueReviewedExternalIngest(fixture.store, {
    sourceType: 'markdown',
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
    reason: 'reviewed_external_graph_integrity_claimed',
  });
  assert.equal(claimed.claimed, true);
  const claimedAt = Number(claimed.approval.context.executionClaim.claimedAt);
  const preparedAt = new Date(claimedAt + 10);
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

function operationId(reservation) {
  return `reviewed-external-graph:${reservation.reservationHash.slice('sha256:'.length)}`;
}

function execute(fixture, built, store = fixture.store, now = built.executedAt) {
  return executeReviewedExternalGraphMutation(
    built.plan,
    built.reservation,
    executionOptions(built.plan, built.reservation, store, fixture.graph, now),
  );
}

test('tampered durable journal result fails closed on approved replay', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture('journal');
  try {
    const built = await buildReserved(fixture, 'graph-integrity-journal');
    const first = execute(fixture, built);
    assert.equal(first.ok, true);

    fixture.graph._db.prepare(
      'UPDATE mutation_journal SET result = ? WHERE operation_id = ?',
    ).run(
      JSON.stringify({ ...first.result, nodeCount: first.result.nodeCount + 1 }),
      operationId(built.reservation),
    );

    const replay = execute(
      fixture,
      built,
      fixture.store,
      new Date(built.executedAt.getTime() + 1_000),
    );
    assert.equal(replay.ok, false);
    assert.equal(replay.code, 'REVIEWED_GRAPH_RESULT_INVALID');
  } finally {
    fixture.close();
  }
});

test('tampered durable receipt payload fails its chained self-hash check', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture('receipt');
  try {
    const built = await buildReserved(fixture, 'graph-integrity-receipt');
    const first = execute(fixture, built);
    assert.equal(first.ok, true);

    const tamperedPayload = {
      ...first.receipt.canonicalPayload,
      sourceRef: `${first.receipt.canonicalPayload.sourceRef}#tampered`,
    };
    fixture.graph._db.prepare(
      'UPDATE mutation_receipts SET canonical_payload = ? WHERE operation_id = ?',
    ).run(JSON.stringify(tamperedPayload), operationId(built.reservation));

    const replay = execute(
      fixture,
      built,
      fixture.store,
      new Date(built.executedAt.getTime() + 1_000),
    );
    assert.equal(replay.ok, false);
    assert.equal(replay.code, 'REVIEWED_GRAPH_RECEIPT_INVALID');
  } finally {
    fixture.close();
  }
});

test('finalization reports success only after exact approved-row readback', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture('finalization-readback');
  try {
    const built = await buildReserved(fixture, 'graph-integrity-finalization');
    const falseSuccessStore = {
      getToolApprovalById(id) {
        return fixture.store.getToolApprovalById(id);
      },
      db: {
        prepare(sql) {
          if (/SET status='approved'/u.test(sql)) {
            return { run() { return { changes: 1 }; } };
          }
          return fixture.store.db.prepare(sql);
        },
      },
    };

    const result = execute(fixture, built, falseSuccessStore);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REVIEWED_GRAPH_FINALIZATION_READBACK_INVALID');
    assert.ok(
      fixture.graph.getCommittedMutationReceiptByOperation(operationId(built.reservation)),
    );
    assert.equal(fixture.store.getToolApprovalById(built.approvalId).status, 'executing');
  } finally {
    fixture.close();
  }
});
