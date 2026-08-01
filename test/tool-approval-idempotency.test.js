'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');
const {
  IDEMPOTENCY_CONTEXT_KEY,
  IDEMPOTENCY_CONTEXT_VERSION,
  saveToolApprovalWithIdempotencyConflict,
} = require('../lib/tool-approval-idempotency');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

const FINGERPRINT_A = `sha256:${'a'.repeat(64)}`;
const FINGERPRINT_B = `sha256:${'b'.repeat(64)}`;

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-approval-idempotency-'));
  const store = new AxiomStorage({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function record(overrides = {}) {
  return {
    id: 'approval-1',
    approvalKey: 'http.ingest.external.request-1',
    tool: 'http.ingest',
    input: '{"snapshot":"a"}',
    context: { source: 'external-ingest' },
    policy: { action: 'ingest', approval: 'review' },
    status: 'pending',
    decision: 'review',
    reason: 'external_ingest_requires_review',
    ...overrides,
  };
}

test('persistent store inserts once and returns a typed idempotent retry for the exact fingerprint/input', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const first = saveToolApprovalWithIdempotencyConflict(store, record(), FINGERPRINT_A);
    assert.equal(first.ok, true);
    assert.equal(first.inserted, true);
    assert.equal(first.idempotent, false);
    assert.equal(first.conflict, false);
    assert.deepEqual(first.approval.context[IDEMPOTENCY_CONTEXT_KEY], {
      version: IDEMPOTENCY_CONTEXT_VERSION,
      fingerprint: FINGERPRINT_A,
    });

    const retry = saveToolApprovalWithIdempotencyConflict(
      store,
      record({ id: 'approval-retry' }),
      FINGERPRINT_A,
    );
    assert.equal(retry.ok, true);
    assert.equal(retry.inserted, false);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.conflict, false);
    assert.equal(retry.approval.id, 'approval-1');
    assert.equal(store.countPendingToolApprovals(), 1);
  });
});

test('same approval key with a different fingerprint fails closed and leaves the persisted row unchanged', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const first = saveToolApprovalWithIdempotencyConflict(store, record(), FINGERPRINT_A);
    assert.equal(first.ok, true);

    const conflict = saveToolApprovalWithIdempotencyConflict(
      store,
      record({ id: 'approval-2', input: '{"snapshot":"b"}' }),
      FINGERPRINT_B,
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.inserted, false);

    const stored = store.getToolApprovalByKey(record().approvalKey);
    assert.equal(stored.id, 'approval-1');
    assert.equal(stored.input, '{"snapshot":"a"}');
    assert.equal(stored.context[IDEMPOTENCY_CONTEXT_KEY].fingerprint, FINGERPRINT_A);
    assert.equal(store.countPendingToolApprovals(), 1);
  });
});

test('same fingerprint cannot mask a different tool or stored input', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    assert.equal(saveToolApprovalWithIdempotencyConflict(store, record(), FINGERPRINT_A).ok, true);

    const changedInput = saveToolApprovalWithIdempotencyConflict(
      store,
      record({ id: 'approval-2', input: '{"snapshot":"different"}' }),
      FINGERPRINT_A,
    );
    assert.equal(changedInput.ok, false);
    assert.equal(changedInput.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');

    const changedTool = saveToolApprovalWithIdempotencyConflict(
      store,
      record({ id: 'approval-3', tool: 'other.tool' }),
      FINGERPRINT_A,
    );
    assert.equal(changedTool.ok, false);
    assert.equal(changedTool.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');
  });
});

test('legacy or unverifiable rows conflict instead of being treated as idempotent', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const direct = store.saveToolApprovalIfAbsent(record());
    assert.equal(direct.inserted, true);
    assert.equal(direct.approval.context[IDEMPOTENCY_CONTEXT_KEY], undefined);

    const result = saveToolApprovalWithIdempotencyConflict(
      store,
      record({ id: 'approval-2' }),
      FINGERPRINT_A,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');
    assert.equal(result.conflict, true);
  });
});

test('different approval keys remain independently insertable', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const first = saveToolApprovalWithIdempotencyConflict(store, record(), FINGERPRINT_A);
    const second = saveToolApprovalWithIdempotencyConflict(
      store,
      record({ id: 'approval-2', approvalKey: 'http.ingest.external.request-2', input: '{"snapshot":"b"}' }),
      FINGERPRINT_B,
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.inserted, true);
    assert.equal(store.countPendingToolApprovals(), 2);
  });
});

test('invalid keys, fingerprints, contexts, and reserved metadata fail before store access', () => {
  let calls = 0;
  const store = {
    saveToolApprovalIfAbsent() {
      calls += 1;
      throw new Error('must not be called');
    },
  };

  const cases = [
    saveToolApprovalWithIdempotencyConflict(null, record(), FINGERPRINT_A),
    saveToolApprovalWithIdempotencyConflict(store, record({ approvalKey: '' }), FINGERPRINT_A),
    saveToolApprovalWithIdempotencyConflict(store, record(), `sha256:${'A'.repeat(64)}`),
    saveToolApprovalWithIdempotencyConflict(store, record({ context: [] }), FINGERPRINT_A),
    saveToolApprovalWithIdempotencyConflict(store, record({
      context: {
        [IDEMPOTENCY_CONTEXT_KEY]: {
          version: IDEMPOTENCY_CONTEXT_VERSION,
          fingerprint: FINGERPRINT_A,
        },
      },
    }), FINGERPRINT_A),
  ];

  for (const result of cases) assert.equal(result.ok, false);
  assert.equal(calls, 0);
});
