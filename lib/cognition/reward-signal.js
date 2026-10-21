'use strict';

const { COGNITION_STATUS, AUTHORITY, round6, freezeResult } = require('./contract');
const { isPlainObject } = require('../is-plain-object');

const SCHEMA_VERSION = 'huqan-cognition-reward-v1';
const EXPECTED_PRIOR = 0;
const RPE_BOUND = 2;
const REWARD_BY_OUTCOME = Object.freeze({
  confirmed: 1,
  'reviewer-rejection': -1,
  rollback: -1,
  compensation: -0.5,
  contradiction: -1,
  incident: -1,
  censored: null,
});
const REWARD_BY_ELIGIBILITY = Object.freeze({ positive_procedure: 1, negative_example: -1 });
const COMMON_FIELDS = ['source', 'key', 'decisionId', 'at', 'expected'];
const SOURCE_FIELDS = Object.freeze({
  'prediction-outcome': ['outcome'],
  'experience-journal': ['eligibility'],
  'step-report': ['status'],
});

function rewardForOutcome(outcome) {
  return typeof outcome === 'string' && Object.hasOwn(REWARD_BY_OUTCOME, outcome) ? REWARD_BY_OUTCOME[outcome] : null;
}

function computeRewardSignal(input) {
  const validObject = isPlainObject(input);
  const data = validObject ? input : {};
  const finish = (status, reason, reward = null) => {
    const measured = status === COGNITION_STATUS.MEASURED;
    const expected = measured ? (data.expected === null ? EXPECTED_PRIOR : data.expected) : null;
    return freezeResult({
      schemaVersion: SCHEMA_VERSION, status,
      key: typeof data.key === 'string' ? data.key : null,
      decisionId: typeof data.decisionId === 'string' ? data.decisionId : null,
      reward, expected,
      expectedSource: measured ? (data.expected === null ? 'prior' : 'value-ledger') : null,
      rpe: measured ? round6(Math.max(-RPE_BOUND, Math.min(RPE_BOUND, reward - expected))) : null,
      rewardSource: typeof data.source === 'string' ? data.source : null,
      at: typeof data.at === 'string' && Number.isFinite(Date.parse(data.at)) ? new Date(data.at).toISOString() : null,
      authority: AUTHORITY.SIGNAL_ONLY, reason,
    });
  };
  const reject = (reason) => finish(COGNITION_STATUS.REJECT, reason);
  if (!validObject) return reject('invalid_input');
  if (typeof data.source !== 'string' || !Object.hasOwn(SOURCE_FIELDS, data.source)) return reject('unknown_source');
  const allowed = [...COMMON_FIELDS, ...SOURCE_FIELDS[data.source]];
  if (Object.keys(data).some((field) => !allowed.includes(field))) return reject('unknown_field');
  if (![data.key, data.decisionId].every((value) => typeof value === 'string' && value.trim())) return reject('invalid_identity');
  if (typeof data.at !== 'string' || !Number.isFinite(Date.parse(data.at))) return reject('invalid_at');
  if (data.expected !== null && !(typeof data.expected === 'number' && Number.isFinite(data.expected) && Math.abs(data.expected) <= 1)) return reject('invalid_expected');
  if (data.source === 'step-report') return finish(COGNITION_STATUS.ABSTAIN, 'reported_not_observed');
  const reward = data.source === 'prediction-outcome'
    ? rewardForOutcome(data.outcome)
    : typeof data.eligibility === 'string' && Object.hasOwn(REWARD_BY_ELIGIBILITY, data.eligibility) ? REWARD_BY_ELIGIBILITY[data.eligibility] : null;
  if (reward === null) return finish(COGNITION_STATUS.ABSTAIN, 'outcome_unknown_or_censored');
  // The caller supplies expectation from history preceding this decision; this pure core cannot inspect that history.
  return finish(COGNITION_STATUS.MEASURED, 'observed_outcome', reward);
}

module.exports = { SCHEMA_VERSION, EXPECTED_PRIOR, RPE_BOUND, REWARD_BY_OUTCOME, REWARD_BY_ELIGIBILITY, rewardForOutcome, computeRewardSignal };
