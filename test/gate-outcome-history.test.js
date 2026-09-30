'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OUTCOME_RECEIPT_KIND,
  verdictForOutcomeStatus,
  outcomeStatusByAdmission,
} = require('../lib/gate-outcome-history');

const outcome = (admissionId, status) => ({ receiptKind: OUTCOME_RECEIPT_KIND, admissionId, status });

test('a refusal sticks whichever order the outcomes arrive in', () => {
  const blockedFirst = outcomeStatusByAdmission([outcome('a1', 'blocked'), outcome('a1', 'executed')]);
  const executedFirst = outcomeStatusByAdmission([outcome('a1', 'executed'), outcome('a1', 'blocked')]);
  assert.equal(blockedFirst.get('a1'), 'blocked');
  assert.equal(executedFirst.get('a1'), 'blocked');
});

test('only outcome receipts with an admission id are reduced', () => {
  const statuses = outcomeStatusByAdmission([
    { receiptKind: 'external_action_admission_receipt', admissionId: 'a1', status: 'executed' },
    outcome('', 'executed'),
    outcome(undefined, 'executed'),
    null,
    'noise',
    outcome('a2', 'executed'),
  ]);
  assert.deepEqual([...statuses.entries()], [['a2', 'executed']]);
});

test('non-array input yields an empty history rather than throwing', () => {
  for (const input of [null, undefined, 'nope', 42, {}]) {
    assert.equal(outcomeStatusByAdmission(input).size, 0);
  }
});

test('executed approves, blocked refuses, anything else is no verdict', () => {
  assert.equal(verdictForOutcomeStatus('executed'), 'approved');
  assert.equal(verdictForOutcomeStatus('blocked'), 'refused');
  for (const status of [undefined, null, '', 'pending', 'failed', 'EXECUTED']) {
    assert.equal(verdictForOutcomeStatus(status), null, String(status));
  }
});

test('both miners and the projection read the same outcome kind', () => {
  assert.equal(require('../lib/residency-rule-miner').OUTCOME_RECEIPT_KIND, OUTCOME_RECEIPT_KIND);
  assert.equal(OUTCOME_RECEIPT_KIND, 'external_action_outcome_receipt');
});
