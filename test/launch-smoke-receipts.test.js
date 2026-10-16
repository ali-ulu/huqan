'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  receiptSemantics,
  validateApprovedReceipt,
  cliVerifyIsVerified,
  mcpVerifyIsVerified,
} = require('../scripts/launch-smoke-receipts');

test('launch-smoke receipts module exposes the predicate vocabulary (#2164)', () => {
  assert.deepEqual(
    Object.keys(require('../scripts/launch-smoke-receipts')).sort(),
    ['cliVerifyIsVerified', 'mcpVerifyIsVerified', 'receiptSemantics', 'validateApprovedReceipt'],
  );
});

function approvedReceipt(overrides = {}) {
  return {
    receiptId: 'r-1',
    receiptKind: 'memory_admission_receipt',
    receiptType: 'memory-admission',
    decision: 'allow',
    status: 'admitted',
    workspaceId: 'ws',
    approvalStatus: 'approved',
    canonical: true,
    reviewed: false,
    quarantined: false,
    rejected: false,
    trustPolicyVersion: '1.0.0',
    approvalId: 'a-1',
    provenanceId: 'p-1',
    ...overrides,
  };
}

function ctx() {
  const failures = [];
  return {
    failures,
    fail: (message) => { failures.push(message); },
    workspaceId: 'ws',
  };
}

test('receiptSemantics projects the reviewed fields', () => {
  assert.deepEqual(receiptSemantics(approvedReceipt()), {
    receiptKind: 'memory_admission_receipt',
    receiptType: 'memory-admission',
    decision: 'allow',
    status: 'admitted',
    workspaceId: 'ws',
    approvalStatus: 'approved',
    canonical: true,
    reviewed: false,
    quarantined: false,
    rejected: false,
    trustPolicyVersion: '1.0.0',
  });
  assert.equal(receiptSemantics(null).receiptKind, null);
});

test('validateApprovedReceipt accepts the approved canonical admission', () => {
  const c = ctx();
  const semantics = validateApprovedReceipt('T', approvedReceipt(), 'a-1', null, c);
  assert.deepEqual(c.failures, []);
  assert.equal(semantics.decision, 'allow');
});

test('validateApprovedReceipt rejects a missing receiptId', () => {
  const c = ctx();
  assert.equal(validateApprovedReceipt('T', { ...approvedReceipt(), receiptId: '' }, 'a-1', null, c), null);
  assert.equal(c.failures.length, 1);
});

test('validateApprovedReceipt rejects a wrong decision', () => {
  const c = ctx();
  assert.equal(validateApprovedReceipt('T', approvedReceipt({ decision: 'deny' }), 'a-1', null, c), null);
  assert.equal(c.failures.length, 1);
});

test('validateApprovedReceipt rejects a workspace mismatch', () => {
  const c = ctx();
  assert.equal(validateApprovedReceipt('T', approvedReceipt({ workspaceId: 'other' }), 'a-1', null, c), null);
  assert.equal(c.failures.length, 1);
});

test('validateApprovedReceipt rejects contradicting refs', () => {
  const c = ctx();
  assert.equal(
    validateApprovedReceipt('T', approvedReceipt(), 'a-1', { provenanceId: 'p-2' }, c),
    null,
  );
  assert.equal(c.failures.length, 1);
});

test('cli verify predicate matches verified envelopes', () => {
  assert.equal(cliVerifyIsVerified({ data: { output: 'Verify: VERIFIED ok' } }), true);
  assert.equal(cliVerifyIsVerified({ data: { output: 'nothing here' } }), false);
  assert.equal(cliVerifyIsVerified(null), false);
});

test('mcp verify predicate matches verified statuses', () => {
  assert.equal(mcpVerifyIsVerified({ data: { status: 'verified' } }), true);
  assert.equal(mcpVerifyIsVerified({ data: { status: 'DOGRULANDI' } }), true);
  assert.equal(mcpVerifyIsVerified({ data: { status: 'unknown' } }), false);
});
