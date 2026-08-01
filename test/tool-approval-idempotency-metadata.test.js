'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IDEMPOTENCY_CONTEXT_KEY,
  IDEMPOTENCY_CONTEXT_VERSION,
  saveToolApprovalWithIdempotencyConflict,
} = require('../lib/tool-approval-idempotency');

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function record(overrides = {}) {
  return {
    id: 'retry-id',
    approvalKey: 'http.ingest.external.request-1',
    tool: 'http.ingest',
    input: '{"snapshot":"a"}',
    context: { source: 'external-ingest', workspaceId: 'tenant-a' },
    policy: { approval: 'review', action: 'ingest' },
    ...overrides,
  };
}

function existingApproval(overrides = {}) {
  return {
    id: 'persisted-id',
    approval_key: 'http.ingest.external.request-1',
    tool: 'http.ingest',
    input: '{"snapshot":"a"}',
    status: 'pending',
    context: {
      source: 'external-ingest',
      workspaceId: 'tenant-a',
      [IDEMPOTENCY_CONTEXT_KEY]: {
        version: IDEMPOTENCY_CONTEXT_VERSION,
        fingerprint: FINGERPRINT,
      },
    },
    policy: { action: 'ingest', approval: 'review' },
    ...overrides,
  };
}

function duplicateStore(approval = existingApproval()) {
  return {
    calls: 0,
    saveToolApprovalIfAbsent() {
      this.calls += 1;
      return { inserted: false, approval };
    },
  };
}

test('exact metadata matches are idempotent independent of JSON key order', () => {
  const store = duplicateStore();
  const result = saveToolApprovalWithIdempotencyConflict(store, record(), FINGERPRINT);

  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.approval.id, 'persisted-id');
  assert.equal(store.calls, 1);
});

test('policy or non-reserved context differences are conflicts and do not expose the persisted record', () => {
  for (const changed of [
    record({ context: { source: 'external-ingest', workspaceId: 'tenant-b' } }),
    record({ policy: { action: 'ingest', approval: 'allow' } }),
  ]) {
    const store = duplicateStore();
    const result = saveToolApprovalWithIdempotencyConflict(store, changed, FINGERPRINT);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');
    assert.equal(result.conflict, true);
    assert.equal(result.approval, undefined);
    assert.equal(result.existingApprovalId, 'persisted-id');
    assert.equal(result.existingStatus, 'pending');
  }
});

test('non-JSON policy and cyclic context fail before persistence', () => {
  let calls = 0;
  const store = {
    saveToolApprovalIfAbsent() {
      calls += 1;
      throw new Error('must not be called');
    },
  };
  const cyclic = {};
  cyclic.self = cyclic;

  const invalidPolicy = saveToolApprovalWithIdempotencyConflict(
    store,
    record({ policy: [] }),
    FINGERPRINT,
  );
  const invalidContext = saveToolApprovalWithIdempotencyConflict(
    store,
    record({ context: cyclic }),
    FINGERPRINT,
  );

  assert.equal(invalidPolicy.ok, false);
  assert.equal(invalidPolicy.code, 'APPROVAL_POLICY_INVALID');
  assert.equal(invalidContext.ok, false);
  assert.equal(invalidContext.code, 'APPROVAL_CONTEXT_INVALID');
  assert.equal(calls, 0);
});
