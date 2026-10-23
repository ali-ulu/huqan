'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HuqanStorage = require('../storage');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-decision-attestation-'));
  const store = new HuqanStorage({
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

function pendingApproval(id) {
  return {
    id,
    approvalKey: 'test.' + id,
    tool: 'huqan.learn',
    input: '{"text":"storage attestation test"}',
    context: { source: 'test' },
    policy: { action: 'learn', approval: 'review' },
    status: 'pending',
    decision: 'review',
    reason: 'test approval',
  };
}

const evidence = Object.freeze({
  schemaVersion: 'huqan.approval-decision-attestation.v1',
  operatorId: 'operator-17',
  receiptHash: 'a'.repeat(64),
});

test('decision attestation storage rejects invalid, missing, and non-final approvals', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    assert.equal(store.attachApprovalDecisionAttestation('', { decisionAttestation: evidence }).reason, 'invalid_evidence');
    assert.equal(store.attachApprovalDecisionAttestation('id', {}).reason, 'invalid_evidence');
    assert.equal(store.attachApprovalDecisionAttestation('id', { decisionAttestation: null }).reason, 'invalid_evidence');
    assert.equal(store.attachApprovalDecisionAttestation('id', { decisionAttestation: 'not-an-object' }).reason, 'invalid_evidence');
    assert.equal(store.attachApprovalDecisionAttestation('id', { decisionAttestation: [] }).reason, 'invalid_evidence');
    assert.equal(store.attachApprovalDecisionAttestation('missing', { decisionAttestation: evidence }).reason, 'not_found');

    store.saveToolApproval(pendingApproval('attestation-pending'));
    const pending = store.attachApprovalDecisionAttestation('attestation-pending', { decisionAttestation: evidence });
    assert.equal(pending.attached, false);
    assert.equal(pending.reason, 'not_final');
    assert.equal(pending.approval.status, 'pending');
  });
});

test('decision attestation storage attaches only to final rows and makes repeats idempotent', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(pendingApproval('attestation-approved'));
    assert.equal(store.resolveToolApproval('attestation-approved', 'approved', 'operator approved').status, 'approved');

    const attached = store.attachApprovalDecisionAttestation('attestation-approved', { decisionAttestation: evidence });
    assert.equal(attached.attached, true);
    assert.equal(attached.reason, 'attached');
    assert.deepEqual(attached.approval.context.decisionAttestation, evidence);

    const duplicate = store.attachApprovalDecisionAttestation('attestation-approved', {
      decisionAttestation: { ...evidence },
    });
    assert.equal(duplicate.attached, true);
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.reason, 'already_attached');

    const conflict = store.attachApprovalDecisionAttestation('attestation-approved', {
      decisionAttestation: { ...evidence, operatorId: 'operator-18' },
    });
    assert.equal(conflict.attached, false);
    assert.equal(conflict.idempotent, false);
    assert.equal(conflict.reason, 'evidence_conflict');

    store.saveToolApproval(pendingApproval('attestation-failed'));
    assert.equal(store.claimToolApproval('attestation-failed').claimed, true);
    assert.equal(store.failToolApproval('attestation-failed', 'execution failed').failed, true);
    const failed = store.attachApprovalDecisionAttestation('attestation-failed', { decisionAttestation: evidence });
    assert.equal(failed.attached, true);
    assert.equal(failed.approval.status, 'failed');

    store.saveToolApproval(pendingApproval('attestation-cancelled'));
    assert.equal(store.claimToolApproval('attestation-cancelled').claimed, true);
    const cancelled = store.finalizeToolApprovalWithReceipt('attestation-cancelled', {
      expectedStatus: 'executing',
      decision: 'cancelled',
      receipt: { receiptId: 'receipt-attestation-cancelled' },
    });
    assert.equal(cancelled.finalized, true);
    const cancelledAttestation = store.attachApprovalDecisionAttestation('attestation-cancelled', {
      decisionAttestation: evidence,
    });
    assert.equal(cancelledAttestation.attached, true);
    assert.equal(cancelledAttestation.approval.status, 'cancelled');
  });
});

test('decision attestation storage reports a lost compare-and-swap race', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(pendingApproval('attestation-race'));
    store.resolveToolApproval('attestation-race', 'approved', 'operator approved');

    const originalStatement = store._stmts.attachApprovalDecisionAttestation;
    store._stmts.attachApprovalDecisionAttestation = { run: () => ({ changes: 0 }) };
    let outcome;
    try {
      outcome = store.attachApprovalDecisionAttestation('attestation-race', { decisionAttestation: evidence });
    } finally {
      store._stmts.attachApprovalDecisionAttestation = originalStatement;
    }
    assert.equal(outcome.attached, false);
    assert.equal(outcome.reason, 'lost_race');
    assert.equal(outcome.approval.context.decisionAttestation, undefined);
  });
});
