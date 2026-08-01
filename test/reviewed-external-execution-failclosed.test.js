'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');
const { queueReviewedExternalIngest } = require('../lib/external-ingest-queue');
const { prepareReviewedExternalExecution } = require('../lib/reviewed-external-execution');
const { IDEMPOTENCY_CONTEXT_KEY } = require('../lib/tool-approval-idempotency');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

async function createExecutingRecord() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-execution-failclosed-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'claim.md'), '# Claim\nImmutable reviewed bytes.\n', 'utf8');
  const store = new AxiomStorage({ memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db') });
  const queued = await queueReviewedExternalIngest(store, {
    sourceType: 'markdown',
    path: 'docs/claim.md',
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: 'failclosed-execution',
  }, {
    now: new Date(),
    markdownRootPath: root,
  });
  assert.equal(queued.ok, true);
  const claimed = store.claimToolApprovalWithLease(queued.approval.id, {
    owner: 'worker:1',
    leaseMs: 120_000,
  });
  assert.equal(claimed.claimed, true);
  return {
    root,
    store,
    record: claimed.approval,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function options(overrides = {}) {
  return {
    now: new Date(),
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    reviewer: 'user:bob',
    leaseOwner: 'worker:1',
    ...overrides,
  };
}

test('status, tool, context, and policy mismatches fail closed', { skip: !HAS_SQLITE }, async () => {
  const fixture = await createExecutingRecord();
  try {
    const cases = [];

    const pending = structuredClone(fixture.record);
    pending.status = 'pending';
    cases.push([pending, 'REVIEWED_EXECUTION_STATUS_INVALID']);

    const tamperedDecision = structuredClone(fixture.record);
    tamperedDecision.decision = 'execution_outcome_unknown';
    cases.push([tamperedDecision, 'REVIEWED_EXECUTION_STATUS_INVALID']);

    const wrongTool = structuredClone(fixture.record);
    wrongTool.tool = 'other.tool';
    cases.push([wrongTool, 'REVIEWED_EXECUTION_TOOL_MISMATCH']);

    const extraContext = structuredClone(fixture.record);
    extraContext.context.extra = true;
    cases.push([extraContext, 'REVIEWED_EXECUTION_CONTEXT_INVALID']);

    const wrongSource = structuredClone(fixture.record);
    wrongSource.context.source = 'other-source';
    cases.push([wrongSource, 'REVIEWED_EXECUTION_CONTEXT_INVALID']);

    const wrongPolicy = structuredClone(fixture.record);
    wrongPolicy.policy.sourceAccess = 'refetch_allowed';
    cases.push([wrongPolicy, 'REVIEWED_EXECUTION_POLICY_INVALID']);

    const extraPolicy = structuredClone(fixture.record);
    extraPolicy.policy.extra = true;
    cases.push([extraPolicy, 'REVIEWED_EXECUTION_POLICY_INVALID']);

    for (const [record, code] of cases) {
      const result = prepareReviewedExternalExecution(record, options());
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.equal(result.plan, undefined);
    }
  } finally {
    fixture.close();
  }
});

test('lease ownership and lease timing are fail-closed', { skip: !HAS_SQLITE }, async () => {
  const fixture = await createExecutingRecord();
  try {
    const current = Date.now();

    const wrongOwner = prepareReviewedExternalExecution(fixture.record, options({ leaseOwner: 'worker:other' }));
    assert.equal(wrongOwner.ok, false);
    assert.equal(wrongOwner.code, 'REVIEWED_EXECUTION_CLAIM_INVALID');

    const notStartedRecord = structuredClone(fixture.record);
    notStartedRecord.context.executionClaim.claimedAt = current + 5_000;
    notStartedRecord.context.executionClaim.leaseExpiresAt = current + 10_000;
    const notStarted = prepareReviewedExternalExecution(notStartedRecord, options({ now: new Date(current) }));
    assert.equal(notStarted.ok, false);
    assert.equal(notStarted.code, 'REVIEWED_EXECUTION_CLAIM_NOT_STARTED');

    const expiredRecord = structuredClone(fixture.record);
    expiredRecord.context.executionClaim.claimedAt = current - 10_000;
    expiredRecord.context.executionClaim.leaseExpiresAt = current;
    const expired = prepareReviewedExternalExecution(expiredRecord, options({ now: new Date(current) }));
    assert.equal(expired.ok, false);
    assert.equal(expired.code, 'REVIEWED_EXECUTION_LEASE_EXPIRED');
  } finally {
    fixture.close();
  }
});

test('fingerprint, persisted input, and reviewed content tampering fail closed', { skip: !HAS_SQLITE }, async () => {
  const fixture = await createExecutingRecord();
  try {
    const fingerprint = structuredClone(fixture.record);
    fingerprint.context[IDEMPOTENCY_CONTEXT_KEY].fingerprint = `sha256:${'0'.repeat(64)}`;
    const fingerprintResult = prepareReviewedExternalExecution(fingerprint, options());
    assert.equal(fingerprintResult.ok, false);
    assert.equal(fingerprintResult.code, 'REVIEWED_EXECUTION_FINGERPRINT_INVALID');

    const input = structuredClone(fixture.record);
    input.input += ' ';
    const inputResult = prepareReviewedExternalExecution(input, options());
    assert.equal(inputResult.ok, false);
    assert.equal(inputResult.code, 'REVIEWED_EXECUTION_RECORD_INTEGRITY_MISMATCH');

    const content = structuredClone(fixture.record);
    content.context.externalApproval.payload.reviewedSource.files[0].content = '# attacker';
    const contentResult = prepareReviewedExternalExecution(content, options());
    assert.equal(contentResult.ok, false);
    assert.notEqual(contentResult.code, undefined);
    assert.equal(contentResult.plan, undefined);
  } finally {
    fixture.close();
  }
});

test('trusted requester, workspace, reviewer, and lease-owner identities are mandatory', { skip: !HAS_SQLITE }, async () => {
  const fixture = await createExecutingRecord();
  try {
    const missingCases = [
      [{ requester: '' }, 'REVIEWED_EXECUTION_REQUESTER_REQUIRED'],
      [{ workspaceId: '' }, 'REVIEWED_EXECUTION_WORKSPACE_REQUIRED'],
      [{ reviewer: '' }, 'REVIEWED_EXECUTION_REVIEWER_REQUIRED'],
      [{ leaseOwner: '' }, 'REVIEWED_EXECUTION_LEASE_OWNER_REQUIRED'],
    ];
    for (const [override, code] of missingCases) {
      const result = prepareReviewedExternalExecution(fixture.record, options(override));
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
    }

    const wrongRequester = prepareReviewedExternalExecution(fixture.record, options({ requester: 'user:mallory' }));
    assert.equal(wrongRequester.ok, false);
    assert.equal(wrongRequester.code, 'EXTERNAL_APPROVAL_REQUESTER_MISMATCH');

    const wrongWorkspace = prepareReviewedExternalExecution(fixture.record, options({ workspaceId: 'tenant-b' }));
    assert.equal(wrongWorkspace.ok, false);
    assert.equal(wrongWorkspace.code, 'EXTERNAL_APPROVAL_WORKSPACE_MISMATCH');
  } finally {
    fixture.close();
  }
});

test('expired reviewed approvals fail even when the execution lease is extended', { skip: !HAS_SQLITE }, async () => {
  const fixture = await createExecutingRecord();
  try {
    const record = structuredClone(fixture.record);
    const expiryMs = Date.parse(record.context.externalApproval.expiresAt);
    record.context.executionClaim.claimedAt = expiryMs - 1_000;
    record.context.executionClaim.leaseExpiresAt = expiryMs + 60_000;

    const result = prepareReviewedExternalExecution(record, options({ now: new Date(expiryMs) }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXTERNAL_APPROVAL_EXPIRED');
    assert.equal(result.plan, undefined);
  } finally {
    fixture.close();
  }
});
