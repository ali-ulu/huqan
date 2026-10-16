'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAPTURED_OUTCOME_STATUS,
  OUTCOME_RECEIPT_KIND,
  isCapturedOutcomeStatus,
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

test('a captured outcome is a gate fault, not a refusal (#3500)', () => {
  assert.equal(CAPTURED_OUTCOME_STATUS, 'captured');
  assert.equal(isCapturedOutcomeStatus('captured'), true);
  for (const status of [undefined, null, '', 'blocked', 'executed', 'failed']) {
    assert.equal(isCapturedOutcomeStatus(status), false, String(status));
  }
  // The whole point: a fail-closed gate fault carries no verdict, so it can
  // never be learned as a person's refusal.
  assert.equal(verdictForOutcomeStatus(CAPTURED_OUTCOME_STATUS), null);
});

test('a captured outcome does not become a refusal when a real one is present', () => {
  const statuses = outcomeStatusByAdmission([
    outcome('a1', CAPTURED_OUTCOME_STATUS),
    outcome('a1', 'blocked'),
    outcome('a2', CAPTURED_OUTCOME_STATUS),
  ]);
  assert.equal(statuses.get('a1'), 'blocked');
  assert.equal(statuses.get('a2'), CAPTURED_OUTCOME_STATUS);
  assert.equal(verdictForOutcomeStatus(statuses.get('a2')), null);
});

test('both miners and the projection read the same outcome kind', () => {
  assert.equal(require('../lib/residency-rule-miner').OUTCOME_RECEIPT_KIND, OUTCOME_RECEIPT_KIND);
  assert.equal(OUTCOME_RECEIPT_KIND, 'external_action_outcome_receipt');
});
