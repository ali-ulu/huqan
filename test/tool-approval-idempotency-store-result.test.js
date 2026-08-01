'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IDEMPOTENCY_CONTEXT_KEY,
  IDEMPOTENCY_CONTEXT_VERSION,
  saveToolApprovalWithIdempotencyConflict,
} = require('../lib/tool-approval-idempotency');

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const RECORD = {
  id: 'new-id',
  approvalKey: 'http.ingest.external.request-1',
  tool: 'http.ingest',
  input: '{"snapshot":"a"}',
  context: { source: 'external-ingest' },
  policy: { action: 'ingest', approval: 'review' },
};

function persisted(overrides = {}) {
  return {
    id: 'persisted-id',
    approval_key: RECORD.approvalKey,
    tool: RECORD.tool,
    input: RECORD.input,
    status: 'pending',
    context: {
      ...RECORD.context,
      [IDEMPOTENCY_CONTEXT_KEY]: {
        version: IDEMPOTENCY_CONTEXT_VERSION,
        fingerprint: FINGERPRINT,
      },
    },
    policy: { ...RECORD.policy },
    ...overrides,
  };
}

test('ambiguous inserted flags are rejected instead of being treated as retries', () => {
  const store = {
    saveToolApprovalIfAbsent() {
      return { inserted: 0, approval: persisted() };
    },
  };
  const result = saveToolApprovalWithIdempotencyConflict(store, RECORD, FINGERPRINT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPROVAL_STORE_RESULT_INVALID');
  assert.equal(result.approval, undefined);
});

test('inserted rows with a mismatched approval key fail store verification without exposing the row', () => {
  const store = {
    saveToolApprovalIfAbsent() {
      return { inserted: true, approval: persisted({ approval_key: 'other-key' }) };
    },
  };
  const result = saveToolApprovalWithIdempotencyConflict(store, RECORD, FINGERPRINT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPROVAL_STORE_RESULT_INVALID');
  assert.equal(result.inserted, true);
  assert.equal(result.approval, undefined);
  assert.equal(result.existingApprovalId, 'persisted-id');
});

test('duplicate rows with a mismatched approval key are conflicts without record disclosure', () => {
  const store = {
    saveToolApprovalIfAbsent() {
      return { inserted: false, approval: persisted({ approval_key: 'other-key' }) };
    },
  };
  const result = saveToolApprovalWithIdempotencyConflict(store, RECORD, FINGERPRINT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');
  assert.equal(result.conflict, true);
  assert.equal(result.approval, undefined);
  assert.equal(result.existingApprovalId, 'persisted-id');
});
