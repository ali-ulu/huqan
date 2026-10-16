'use strict';

// assertCommittedMatches is the last check before a commit is reported as
// done: every field it compares must be able to refuse on its own (#2149).

const test = require('node:test');
const assert = require('node:assert/strict');

const { assertCommittedMatches } = require('./external-client-mutation-receipt-owner-records');
const { EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS } = require('./external-client-mutation-receipt-owner-contract');

const expectedResult = Object.freeze({
  outcome: 'pending_review',
  operationId: 'op-1',
  workspaceId: 'ws-1',
  packageId: 'pkg-1',
  packageHash: 'a'.repeat(64),
  externalCandidateId: 'ext-1',
  localCandidateId: 'local-1',
  receiptId: 'receipt-1',
});
const canonicalReceipt = Object.freeze({ receiptId: 'receipt-1', decision: 'review' });
const expected = { operationId: 'op-1', receiptId: 'receipt-1', workspaceId: 'ws-1', canonicalReceipt, expectedResult };

function committed(receiptOverrides = {}, overrides = {}) {
  return {
    replayed: false,
    result: { ...expectedResult },
    receipt: {
      operationId: 'op-1',
      receiptId: 'receipt-1',
      workspaceId: 'ws-1',
      canonicalPayload: { ...canonicalReceipt },
      receiptHash: 'b'.repeat(64),
      ...receiptOverrides,
    },
    ...overrides,
  };
}

const unknown = { code: EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN };

test('a commit that matches every expected field is accepted', () => {
  assert.doesNotThrow(() => assertCommittedMatches(committed(), expected));
});

test('each reconciled field refuses on its own', () => {
  const cases = [
    ['receiptId', committed({ receiptId: 'receipt-2' })],
    ['operationId', committed({ operationId: 'op-2' })],
    ['workspaceId', committed({ workspaceId: 'ws-2' })],
    ['canonicalPayload', committed({ canonicalPayload: { receiptId: 'receipt-1', decision: 'allow' } })],
    ['receiptHash', committed({ receiptHash: 'not-a-hash' })],
    ['replayed', committed({}, { replayed: 'no' })],
    ['result', committed({}, { result: { ...expectedResult, outcome: 'committed' } })],
    ['missing commit', null],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => assertCommittedMatches(value, expected), unknown, field);
  }
});
