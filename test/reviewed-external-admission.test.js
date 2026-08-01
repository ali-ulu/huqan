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
const {
  REVIEWED_EXTERNAL_ADMISSION_VERSION,
  admitReviewedExternalCandidatePlan,
} = require('../lib/reviewed-external-admission');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-admission-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const sourcePath = path.join(root, 'docs', 'claim.md');
  fs.writeFileSync(sourcePath, '# Claim\nReviewed admission bytes.\n', 'utf8');
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

function admissionOptions(plan, approvalStore, now, overrides = {}) {
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
    ...overrides,
  };
}

async function buildCandidate(fixture, {
  idempotencyKey = 'admission-1',
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
    reason: 'reviewed_external_admission_claimed',
  });
  assert.equal(claimed.claimed, true);
  const claim = claimed.approval.context.executionClaim;
  const preparedAt = new Date(Number(claim.claimedAt) + 10);

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

  return {
    approvalId: queued.approval.id,
    executing: claimed.approval,
    preparedAt,
    plan: candidate.plan,
  };
}

test('live persistent state reproduces the exact candidate plan and yields a frozen content-free admission ticket', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildCandidate(fixture);
    fs.unlinkSync(fixture.sourcePath);

    let reads = 0;
    const readOnlyStore = {
      getToolApprovalById(id) {
        reads += 1;
        return fixture.store.getToolApprovalById(id);
      },
    };
    const admittedAt = new Date(built.preparedAt.getTime() + 1_000);
    const result = admitReviewedExternalCandidatePlan(
      built.plan,
      admissionOptions(built.plan, readOnlyStore, admittedAt),
    );

    assert.equal(result.ok, true);
    assert.equal(reads, 1, 'admission must use one authoritative persistent read');
    assert.equal(result.admission.version, REVIEWED_EXTERNAL_ADMISSION_VERSION);
    assert.equal(result.admission.candidatePlanHash, built.plan.candidatePlanHash);
    assert.equal(result.admission.admittedAt, admittedAt.toISOString());
    assert.match(result.admission.approvalRecordHash, /^sha256:[0-9a-f]{64}$/u);
    assert.match(result.admission.admissionHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(result.admission), true);
    assert.throws(() => { result.admission.reviewer = 'user:mallory'; }, TypeError);

    const serialized = JSON.stringify(result.admission);
    assert.equal(serialized.includes('Reviewed admission bytes'), false);
    assert.equal(Object.hasOwn(result.admission, 'candidates'), false);
    assert.equal(Object.hasOwn(result.admission, 'decision'), false);
    assert.equal(Object.hasOwn(result.admission, 'receipt'), false);
  } finally {
    fixture.close();
  }
});

test('trusted admission bindings are mandatory and mismatches fail before store access', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildCandidate(fixture, { idempotencyKey: 'admission-trust' });
    let reads = 0;
    const reader = {
      getToolApprovalById(id) {
        reads += 1;
        return fixture.store.getToolApprovalById(id);
      },
    };
    const now = new Date(built.preparedAt.getTime() + 1_000);

    const missingReviewer = admissionOptions(built.plan, reader, now);
    delete missingReviewer.reviewer;
    assert.equal(
      admitReviewedExternalCandidatePlan(built.plan, missingReviewer).code,
      'REVIEWED_ADMISSION_TRUST_CONTEXT_REQUIRED',
    );

    assert.equal(
      admitReviewedExternalCandidatePlan(
        built.plan,
        admissionOptions(built.plan, reader, now, {
          approvalKey: 'approval-key:other',
        }),
      ).code,
      'REVIEWED_ADMISSION_TRUST_CONTEXT_MISMATCH',
    );

    assert.equal(
      admitReviewedExternalCandidatePlan(
        built.plan,
        admissionOptions(built.plan, reader, now, {
          candidatePlanHash: `sha256:${'f'.repeat(64)}`,
        }),
      ).code,
      'REVIEWED_ADMISSION_TRUST_CONTEXT_MISMATCH',
    );
    assert.equal(reads, 0);
  } finally {
    fixture.close();
  }
});

test('tampered or extended candidate plans fail exact persisted-byte reproduction', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildCandidate(fixture, { idempotencyKey: 'admission-tamper' });
    const now = new Date(built.preparedAt.getTime() + 1_000);

    const tampered = structuredClone(built.plan);
    tampered.candidates[0].label = 'tampered label';
    assert.equal(
      admitReviewedExternalCandidatePlan(
        tampered,
        admissionOptions(tampered, fixture.store, now),
      ).code,
      'REVIEWED_ADMISSION_CANDIDATE_MISMATCH',
    );

    const extended = structuredClone(built.plan);
    extended.unreviewed = true;
    assert.equal(
      admitReviewedExternalCandidatePlan(
        extended,
        admissionOptions(extended, fixture.store, now),
      ).code,
      'REVIEWED_ADMISSION_CANDIDATE_MISMATCH',
    );
  } finally {
    fixture.close();
  }
});

test('lease renewal makes a previously generated candidate stale and forces regeneration', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildCandidate(fixture, { idempotencyKey: 'admission-renewal' });
    const renewed = fixture.store.renewToolApprovalLease(built.approvalId, 'worker:1', 120_000);
    assert.equal(renewed.renewed, true);

    const result = admitReviewedExternalCandidatePlan(
      built.plan,
      admissionOptions(
        built.plan,
        fixture.store,
        new Date(built.preparedAt.getTime() + 1_000),
      ),
    );
    assert.equal(result.code, 'REVIEWED_ADMISSION_CANDIDATE_MISMATCH');
  } finally {
    fixture.close();
  }
});

test('expired leases, missing rows, invalid metadata and store errors fail closed', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildCandidate(fixture, { idempotencyKey: 'admission-failclosed' });
    const expiresAt = Number(built.executing.context.executionClaim.leaseExpiresAt);

    const expired = admitReviewedExternalCandidatePlan(
      built.plan,
      admissionOptions(built.plan, fixture.store, new Date(expiresAt)),
    );
    assert.equal(expired.code, 'REVIEWED_ADMISSION_PERSISTED_STATE_INVALID');
    assert.equal(expired.meta.causeCode, 'REVIEWED_EXECUTION_LEASE_EXPIRED');

    const missing = admitReviewedExternalCandidatePlan(
      built.plan,
      admissionOptions(built.plan, { getToolApprovalById() { return null; } }, new Date(built.preparedAt.getTime() + 1_000)),
    );
    assert.equal(missing.code, 'REVIEWED_ADMISSION_RECORD_NOT_FOUND');

    const invalidMetadata = admitReviewedExternalCandidatePlan(
      built.plan,
      admissionOptions(built.plan, {
        getToolApprovalById(id) {
          const record = fixture.store.getToolApprovalById(id);
          return { ...record, updated_at: 'not-a-number' };
        },
      }, new Date(built.preparedAt.getTime() + 1_000)),
    );
    assert.equal(invalidMetadata.code, 'REVIEWED_ADMISSION_RECORD_METADATA_INVALID');

    const readFailure = admitReviewedExternalCandidatePlan(
      built.plan,
      admissionOptions(built.plan, {
        getToolApprovalById() { throw new Error('private storage detail'); },
      }, new Date(built.preparedAt.getTime() + 1_000)),
    );
    assert.equal(readFailure.code, 'REVIEWED_ADMISSION_STORE_READ_FAILED');
    assert.equal(JSON.stringify(readFailure).includes('private storage detail'), false);
  } finally {
    fixture.close();
  }
});

test('self-approval remains visible without introducing an approval or mutation decision', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const built = await buildCandidate(fixture, {
      idempotencyKey: 'admission-self',
      reviewer: 'user:alice',
    });
    const result = admitReviewedExternalCandidatePlan(
      built.plan,
      admissionOptions(
        built.plan,
        fixture.store,
        new Date(built.preparedAt.getTime() + 1_000),
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.admission.selfApproval, true);
    assert.equal(result.admission.requester, 'user:alice');
    assert.equal(result.admission.reviewer, 'user:alice');
    assert.equal(Object.hasOwn(result.admission, 'allowed'), false);
    assert.equal(Object.hasOwn(result.admission, 'decision'), false);
  } finally {
    fixture.close();
  }
});

test('admission module has no source access, graph, kernel, capability or persistence mutation call', () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'reviewed-external-admission.js'),
    'utf8',
  );
  assert.doesNotMatch(moduleSource, /require\(['"](?:fs|node:fs|https?|node:https?|child_process|node:child_process)['"]\)/u);
  assert.doesNotMatch(moduleSource, /\b(?:fetch|kernel|proposeNode|proposeEdge|runCapability|runMutationOnce)\s*\(/u);
  assert.doesNotMatch(moduleSource, /\.(?:claimToolApproval|renewToolApprovalLease|resolveToolApproval|finalizeToolApprovalWithReceipt|failToolApproval)\s*\(/u);
});
