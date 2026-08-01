'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');
const { queueReviewedExternalIngest } = require('../lib/external-ingest-queue');
const { prepareReviewedExternalExecution } = require('../lib/reviewed-external-execution');
const { materializeReviewedExternalIngestBatch } = require('../lib/reviewed-external-ingest-batch');
const { buildReviewedExternalCandidatePlan } = require('../lib/reviewed-external-ingest-candidates');
const { admitReviewedExternalCandidatePlan } = require('../lib/reviewed-external-admission');
const {
  REVIEWED_EXTERNAL_ADMISSION_RESERVATION_VERSION,
  reserveReviewedExternalAdmission,
} = require('../lib/reviewed-external-admission-reservation');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-reservation-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const sourcePath = path.join(root, 'docs', 'claim.md');
  fs.writeFileSync(sourcePath, '# Claim\nReviewed reservation bytes.\n', 'utf8');
  const store = new AxiomStorage({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  return {
    root,
    sourcePath,
    store,
    close() {
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

function reservationOptions(admission, approvalStore, now, overrides = {}) {
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
    ...overrides,
  };
}

async function buildAdmission(fixture, {
  idempotencyKey = 'reservation-1',
  reviewer = 'user:bob',
} = {}) {
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
    leaseMs: 60_000,
    reason: 'reviewed_external_reservation_claimed',
  });
  assert.equal(claimed.claimed, true);
  const claim = claimed.approval.context.executionClaim;
  const preparedAt = new Date(Number(claim.claimedAt) + 10);
  const admittedAt = new Date(preparedAt.getTime() + 1_000);

  const prepared = prepareReviewedExternalExecution(claimed.approval, {
    now: preparedAt,
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    reviewer,
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

  return {
    approvalId: queued.approval.id,
    admittedAt,
    admission: admitted.admission,
  };
}

test('exact unchanged approval row is atomically reserved once without source access or graph mutation', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildAdmission(fixture);
    fs.unlinkSync(fixture.sourcePath);
    const now = new Date(built.admittedAt.getTime() + 1_000);

    const result = reserveReviewedExternalAdmission(
      built.admission,
      reservationOptions(built.admission, fixture.store, now),
    );
    assert.equal(result.ok, true);
    assert.equal(result.reservation.version, REVIEWED_EXTERNAL_ADMISSION_RESERVATION_VERSION);
    assert.equal(result.reservation.admissionHash, built.admission.admissionHash);
    assert.equal(result.reservation.candidatePlanHash, built.admission.candidatePlanHash);
    assert.equal(result.reservation.approvalRecordHash, built.admission.approvalRecordHash);
    assert.equal(result.reservation.reservedAt, now.toISOString());
    assert.equal(result.reservation.approvalUpdatedAt > built.admission.approvalUpdatedAt, true);
    assert.match(result.reservation.reservationHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(result.reservation), true);
    assert.throws(() => { result.reservation.leaseOwner = 'worker:other'; }, TypeError);

    const persisted = fixture.store.getToolApprovalById(built.approvalId);
    assert.deepEqual(persisted.context.reviewedExternalAdmissionReservation, result.reservation);
    assert.equal(persisted.context.executionClaim.owner, 'worker:1');
    assert.equal(persisted.status, 'executing');
    assert.equal(persisted.decision, 'approved');
    assert.equal(persisted.decided_at, 0);
    assert.equal(persisted.reason, 'reviewed_external_admission_reserved');
    assert.equal(persisted.updated_at, result.reservation.approvalUpdatedAt);
    assert.equal(Object.hasOwn(persisted.context, 'receipt'), false);

    const duplicate = reserveReviewedExternalAdmission(
      built.admission,
      reservationOptions(built.admission, fixture.store, now),
    );
    assert.equal(duplicate.ok, false);
    assert.equal([
      'REVIEWED_RESERVATION_ALREADY_RESERVED',
      'REVIEWED_RESERVATION_RECORD_CHANGED',
    ].includes(duplicate.code), true);
  } finally {
    fixture.close();
  }
});

test('trusted bindings fail before any persistent read or write', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildAdmission(fixture, { idempotencyKey: 'reservation-trust' });
    let reads = 0;
    let prepares = 0;
    const guardedStore = {
      getToolApprovalById() {
        reads += 1;
        return fixture.store.getToolApprovalById(built.approvalId);
      },
      db: {
        prepare() {
          prepares += 1;
          throw new Error('must not prepare');
        },
      },
    };
    const now = new Date(built.admittedAt.getTime() + 1_000);
    const options = reservationOptions(built.admission, guardedStore, now);
    delete options.reviewer;
    assert.equal(
      reserveReviewedExternalAdmission(built.admission, options).code,
      'REVIEWED_RESERVATION_TRUST_CONTEXT_REQUIRED',
    );
    assert.equal(reads, 0);
    assert.equal(prepares, 0);

    assert.equal(
      reserveReviewedExternalAdmission(
        built.admission,
        reservationOptions(built.admission, guardedStore, now, {
          candidatePlanHash: `sha256:${'f'.repeat(64)}`,
        }),
      ).code,
      'REVIEWED_RESERVATION_TRUST_CONTEXT_MISMATCH',
    );
    assert.equal(reads, 0);
    assert.equal(prepares, 0);
  } finally {
    fixture.close();
  }
});

test('tampered or extended admission tickets fail before storage mutation', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildAdmission(fixture, { idempotencyKey: 'reservation-tamper' });
    const before = fixture.store.getToolApprovalById(built.approvalId);
    const now = new Date(built.admittedAt.getTime() + 1_000);

    const tampered = structuredClone(built.admission);
    tampered.candidateCount += 1;
    assert.equal(
      reserveReviewedExternalAdmission(
        tampered,
        reservationOptions(tampered, fixture.store, now),
      ).code,
      'REVIEWED_RESERVATION_ADMISSION_HASH_MISMATCH',
    );

    const extended = structuredClone(built.admission);
    extended.unreviewed = true;
    assert.equal(
      reserveReviewedExternalAdmission(
        extended,
        reservationOptions(extended, fixture.store, now),
      ).code,
      'REVIEWED_RESERVATION_ADMISSION_FIELDS_INVALID',
    );

    const after = fixture.store.getToolApprovalById(built.approvalId);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(Object.hasOwn(after.context, 'reviewedExternalAdmissionReservation'), false);
  } finally {
    fixture.close();
  }
});

test('lease renewal after admission invalidates the stale ticket before CAS', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildAdmission(fixture, { idempotencyKey: 'reservation-renewal' });
    const renewed = fixture.store.renewToolApprovalLease(built.approvalId, 'worker:1', 120_000);
    assert.equal(renewed.renewed, true);

    const result = reserveReviewedExternalAdmission(
      built.admission,
      reservationOptions(
        built.admission,
        fixture.store,
        new Date(built.admittedAt.getTime() + 1_000),
      ),
    );
    assert.equal(result.ok, false);
    assert.equal([
      'REVIEWED_RESERVATION_RECORD_CHANGED',
      'REVIEWED_RESERVATION_RECORD_HASH_MISMATCH',
    ].includes(result.code), true);
    assert.equal(
      Object.hasOwn(
        fixture.store.getToolApprovalById(built.approvalId).context,
        'reviewedExternalAdmissionReservation',
      ),
      false,
    );
  } finally {
    fixture.close();
  }
});

test('a concurrent row change loses the atomic CAS and persists no reservation', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildAdmission(fixture, { idempotencyKey: 'reservation-race' });
    const racingStore = {
      getToolApprovalById(id) {
        return fixture.store.getToolApprovalById(id);
      },
      db: {
        prepare() {
          return {
            run() {
              const renewed = fixture.store.renewToolApprovalLease(built.approvalId, 'worker:1', 120_000);
              assert.equal(renewed.renewed, true);
              return { changes: 0 };
            },
          };
        },
      },
    };

    const result = reserveReviewedExternalAdmission(
      built.admission,
      reservationOptions(
        built.admission,
        racingStore,
        new Date(built.admittedAt.getTime() + 1_000),
      ),
    );
    assert.equal(result.code, 'REVIEWED_RESERVATION_CAS_FAILED');
    assert.equal(
      Object.hasOwn(
        fixture.store.getToolApprovalById(built.approvalId).context,
        'reviewedExternalAdmissionReservation',
      ),
      false,
    );
  } finally {
    fixture.close();
  }
});

test('expired time and storage failures fail closed without private exception details', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildAdmission(fixture, { idempotencyKey: 'reservation-errors' });
    assert.equal(
      reserveReviewedExternalAdmission(
        built.admission,
        reservationOptions(
          built.admission,
          fixture.store,
          new Date(built.admission.leaseExpiresAt),
        ),
      ).code,
      'REVIEWED_RESERVATION_LEASE_EXPIRED',
    );

    const writeFailure = reserveReviewedExternalAdmission(
      built.admission,
      reservationOptions(built.admission, {
        getToolApprovalById(id) {
          return fixture.store.getToolApprovalById(id);
        },
        db: {
          prepare() {
            return {
              run() { throw new Error('private sqlite detail'); },
            };
          },
        },
      }, new Date(built.admittedAt.getTime() + 1_000)),
    );
    assert.equal(writeFailure.code, 'REVIEWED_RESERVATION_STORE_WRITE_FAILED');
    assert.equal(JSON.stringify(writeFailure).includes('private sqlite detail'), false);
  } finally {
    fixture.close();
  }
});

test('self-approval remains visible but reservation makes no policy or graph decision', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildAdmission(fixture, {
      idempotencyKey: 'reservation-self',
      reviewer: 'user:alice',
    });
    const result = reserveReviewedExternalAdmission(
      built.admission,
      reservationOptions(
        built.admission,
        fixture.store,
        new Date(built.admittedAt.getTime() + 1_000),
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.reservation.selfApproval, true);
    assert.equal(result.reservation.requester, 'user:alice');
    assert.equal(result.reservation.reviewer, 'user:alice');
    assert.equal(Object.hasOwn(result.reservation, 'allowed'), false);
    assert.equal(Object.hasOwn(result.reservation, 'decision'), false);
  } finally {
    fixture.close();
  }
});

test('reservation module has no source, network, graph, kernel, capability, receipt or approval-finalization call', () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'reviewed-external-admission-reservation.js'),
    'utf8',
  );
  assert.doesNotMatch(moduleSource, /require\(['"](?:fs|node:fs|https?|node:https?|child_process|node:child_process)['"]\)/u);
  assert.doesNotMatch(moduleSource, /\b(?:fetch|kernel|proposeNode|proposeEdge|runCapability|runMutationOnce)\s*\(/u);
  assert.doesNotMatch(moduleSource, /\.(?:claimToolApproval|renewToolApprovalLease|resolveToolApproval|finalizeToolApprovalWithReceipt|failToolApproval)\s*\(/u);
  assert.match(moduleSource, /UPDATE tool_approvals/u);
  assert.doesNotMatch(moduleSource, /\b(?:INSERT|DELETE)\s+(?:INTO|FROM)\s+tool_approvals/iu);
});
