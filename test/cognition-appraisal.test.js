'use strict';

// COG-A (#4391, PR-1): pure, deterministic appraisal of source-bound
// observations. Unknown evidence never becomes a neutral or zero reading.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appraise, SATISFACTION_GOAL_MIN, SURPRISE_UNEXPECTEDNESS_MIN, REGRET_RESPONSIBILITY_MIN,
} = require('../lib/cognition/appraisal');

const observation = (extra = {}) => ({
  eventId: 'evt_1',
  workspaceId: 'ws_1',
  at: '2026-10-31T10:00:00.000Z',
  asOf: '2026-10-31T10:00:01.000Z',
  goalImpact: { value: 0.8, source: 'verified-outcome:run-1' },
  ...extra,
});

const withheldReason = (result, label) => result.withheld.find((row) => row.label === label)?.reason;

test('derives satisfaction from a source-bound positive goal impact', () => {
  const result = appraise(observation());
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.label, 'satisfaction');
  assert.equal(result.labels.length, 1);
  assert.deepEqual(result.labels[0].support, { goalImpact: 0.8 });
  assert.equal(result.dimensions.goalImpact.status, 'KNOWN');
  assert.equal(result.dimensions.goalImpact.source, 'verified-outcome:run-1');
  assert.equal(result.authority, 'SIGNAL_ONLY');
  assert.ok(result.unknownDimensions.includes('unexpectedness'));
});

test('surprise is derived from unexpectedness even when the goal did not move', () => {
  const result = appraise(observation({
    goalImpact: { value: 0, source: 'verified-outcome:run-2' },
    unexpectedness: { value: SURPRISE_UNEXPECTEDNESS_MIN, source: 'prediction-error:pair-9' },
  }));
  assert.equal(result.status, 'MEASURED');
  assert.deepEqual(result.labels.map((row) => row.label), ['surprise']);
  assert.equal(withheldReason(result, 'satisfaction'), 'goal_below_satisfaction_threshold');
});

test('satisfaction and surprise are reported together in a fixed order', () => {
  const result = appraise(observation({
    unexpectedness: { value: 0.9, source: 'prediction-error:pair-9' },
  }));
  assert.deepEqual(result.labels.map((row) => row.label), ['satisfaction', 'surprise']);
  assert.equal(result.label, 'satisfaction');
});

test('a value without provenance stays unknown and never satisfies a label', () => {
  const result = appraise(observation({ goalImpact: { value: 0.9 } }));
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.dimensions.goalImpact.status, 'UNKNOWN');
  assert.equal(result.dimensions.goalImpact.reason, 'source_missing');
  assert.ok(result.unknownDimensions.includes('goalImpact'));
  assert.equal(withheldReason(result, 'satisfaction'), 'source_missing');
});

test('a missing dimension is unknown, not zero', () => {
  const result = appraise(observation({ goalImpact: undefined }));
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.dimensions.goalImpact.status, 'UNKNOWN');
  assert.equal(result.dimensions.goalImpact.reason, 'evidence_missing');
  assert.equal(withheldReason(result, 'satisfaction'), 'evidence_missing');
  assert.equal(result.sourceDigest.length, 64);
});

test('regret requires own contribution and a better supported alternative', () => {
  const result = appraise(observation({
    goalImpact: { value: -0.8, source: 'verified-outcome:run-3' },
    responsibility: { value: 0.9, source: 'agent-caused:step-4' },
    alternative: { better: true, source: 'counterfactual:plan-b' },
  }));
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.label, 'regret');
  assert.deepEqual(result.labels[0].support, { goalImpact: -0.8, responsibility: 0.9, alternative: true });
});

test('a negative outcome alone never produces regret', () => {
  const negative = { value: -0.8, source: 'verified-outcome:run-3' };
  const noResponsibility = appraise(observation({ goalImpact: negative }));
  assert.equal(noResponsibility.status, 'ABSTAIN');
  assert.equal(withheldReason(noResponsibility, 'regret'), 'responsibility_unknown');

  const lowContribution = appraise(observation({
    goalImpact: negative,
    responsibility: { value: REGRET_RESPONSIBILITY_MIN - 0.1, source: 'agent-caused:step-4' },
    alternative: { better: true, source: 'counterfactual:plan-b' },
  }));
  assert.equal(withheldReason(lowContribution, 'regret'), 'own_contribution_insufficient');

  const noAlternative = appraise(observation({
    goalImpact: negative,
    responsibility: { value: 0.9, source: 'agent-caused:step-4' },
  }));
  assert.equal(withheldReason(noAlternative, 'regret'), 'alternative_missing');

  const notBetter = appraise(observation({
    goalImpact: negative,
    responsibility: { value: 0.9, source: 'agent-caused:step-4' },
    alternative: { better: false, source: 'counterfactual:plan-b' },
  }));
  assert.equal(withheldReason(notBetter, 'regret'), 'no_better_alternative');
});

test('anxiety and frustration are withheld until the future-goal contract exists', () => {
  const result = appraise(observation({
    controllability: { value: 0.9, source: 'control:step-4' },
    uncertainty: { value: 0.9, source: 'uncertainty:step-4' },
  }));
  assert.equal(withheldReason(result, 'anxiety'), 'future_goal_contract_not_established');
  assert.equal(withheldReason(result, 'frustration'), 'future_goal_contract_not_established');
  assert.ok(!result.labels.some((row) => row.label === 'anxiety' || row.label === 'frustration'));
});

test('uncertainty is recorded but never converts into a label or a confidence', () => {
  const result = appraise(observation({
    uncertainty: { value: 0.99, source: 'uncertainty:step-4' },
  }));
  assert.equal(result.dimensions.uncertainty.value, 0.99);
  assert.deepEqual(result.labels.map((row) => row.label), ['satisfaction']);
  assert.equal('confidence' in result, false);
});

test('a future observation is rejected', () => {
  const result = appraise(observation({
    at: '2026-10-31T10:00:02.000Z',
    asOf: '2026-10-31T10:00:01.000Z',
  }));
  assert.equal(result.status, 'REJECT');
  assert.equal(result.reason, 'future_observation');
});

test('evidence from another workspace is rejected', () => {
  const result = appraise(observation({
    goalImpact: { value: 0.8, source: 'verified-outcome:run-1', workspaceId: 'ws_2' },
  }));
  assert.equal(result.status, 'REJECT');
  assert.equal(result.reason, 'cross_workspace_evidence');
});

test('malformed evidence and unknown keys are rejected instead of guessed', () => {
  assert.equal(appraise(observation({ goalImpact: { value: 2, source: 'x' } })).reason, 'invalid_evidence:goalImpact');
  assert.equal(appraise(observation({ unexpectedness: { value: -1, source: 'x' } })).reason, 'invalid_evidence:unexpectedness');
  assert.equal(appraise(observation({ alternative: { better: 'yes', source: 'x' } })).reason, 'invalid_evidence:alternative');
  assert.equal(appraise(observation({ goalImpact: { value: 0.8, source: 'x', extra: 1 } })).reason, 'invalid_evidence:goalImpact');
  assert.equal(appraise(observation({ futureGoal: { value: 1, source: 'x' } })).reason, 'invalid_input');
  assert.equal(appraise(null).reason, 'invalid_input');
  assert.equal(appraise({ eventId: 'evt_1' }).reason, 'invalid_input');
});

test('replay is deterministic, digest-bound and does not mutate the input', () => {
  const input = observation({
    unexpectedness: { value: 0.7, source: 'prediction-error:pair-9' },
    responsibility: { value: 0.6, source: 'agent-caused:step-4' },
  });
  const snapshot = JSON.stringify(input);
  const first = appraise(input);
  const second = appraise(input);
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.labels));
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(first.sources.map((row) => row.dimension), ['goalImpact', 'responsibility', 'unexpectedness']);

  const changed = appraise({ ...input, goalImpact: { value: 0.8, source: 'verified-outcome:run-other' } });
  assert.notEqual(first.sourceDigest, changed.sourceDigest);
  assert.equal(appraise({ ...input }).sourceDigest, first.sourceDigest);
});

test('throwing getters and proxy traps are rejected instead of escaping', () => {
  const withThrowingGetter = (target, key) => Object.defineProperty(target, key, {
    configurable: true, enumerable: true, get() { throw new Error('hostile getter'); },
  });
  for (const hostile of [
    withThrowingGetter(observation(), 'eventId'),
    withThrowingGetter(observation(), 'goalImpact'),
    observation({ goalImpact: withThrowingGetter({ source: 'verified-outcome:run-1' }, 'value') }),
    observation({ alternative: withThrowingGetter({ source: 'counterfactual:plan-b' }, 'better') }),
  ]) {
    const result = appraise(hostile);
    assert.equal(result.status, 'REJECT');
    assert.equal(result.reason, 'invalid_input');
  }
  const hostileKeys = new Proxy({}, { ownKeys() { throw new Error('hostile trap'); } });
  assert.equal(appraise(hostileKeys).reason, 'invalid_input');
});

test('the thresholds are the documented design starting points', () => {
  assert.equal(SATISFACTION_GOAL_MIN, 0.5);
  assert.equal(SURPRISE_UNEXPECTEDNESS_MIN, 0.5);
  assert.equal(REGRET_RESPONSIBILITY_MIN, 0.5);
});
