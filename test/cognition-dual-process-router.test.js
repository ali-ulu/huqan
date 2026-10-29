'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SCHEMA_VERSION, WEIGHTS, S1_MAX_DEMAND, S2_MIN_DEMAND, MODES, adviseMode } = require('../lib/cognition/dual-process-router');

const trustedRoute = (over = {}) => ({ requestId: 'req_1', chosenCapabilityId: 'stored-ab', refusalReason: null, trustState: 'trusted', ...over });
const input = (over = {}) => ({
  route: trustedRoute(), riskLevel: 'low',
  predictionError: { recentMean: 0.1 }, value: { supportScore: 0.7 }, novelty: 0.2, arousal: 0.1, ...over,
});

test('the contract example yields SYSTEM1 with the documented demand and components', () => {
  const advice = adviseMode(input());
  assert.equal(advice.schemaVersion, SCHEMA_VERSION);
  assert.equal(advice.mode, MODES.SYSTEM1);
  assert.equal(advice.demand, 0.17);
  assert.deepEqual(advice.components, { predictionError: 0.1, uncertainty: 0.3, novelty: 0.2, arousal: 0.1 });
  assert.deepEqual(advice.unknownComponents, []);
  assert.deepEqual(advice.reasons, ['low_demand_trusted_procedure']);
  assert.deepEqual(advice.routeRef, { requestId: 'req_1', chosenCapabilityId: 'stored-ab' });
});

test('high or unknown risk always yields SYSTEM2', () => {
  for (const riskLevel of ['high', 'critical', 'HIGH', 'CRITICAL', 'bogus', '', undefined, null, 7]) {
    const advice = adviseMode(input({ riskLevel }));
    assert.equal(advice.mode, MODES.SYSTEM2, `riskLevel=${JSON.stringify(riskLevel)}`);
    assert.deepEqual(advice.reasons, ['risk_requires_deliberation']);
  }
  // Even a low-demand, fully-known input cannot be routed to S1 on high risk.
  assert.equal(adviseMode(input({ riskLevel: 'HIGH', novelty: 0, arousal: 0, predictionError: { recentMean: 0 }, value: { supportScore: 1 } })).mode, MODES.SYSTEM2);
});

test('router refusal yields SYSTEM2', () => {
  const advice = adviseMode(input({ route: trustedRoute({ refusalReason: 'no_eligible_match' }) }));
  assert.equal(advice.mode, MODES.SYSTEM2);
  assert.deepEqual(advice.reasons, ['no_compiled_procedure']);
  // A missing winner is the same signal.
  assert.deepEqual(adviseMode(input({ route: trustedRoute({ chosenCapabilityId: null }) })).reasons, ['no_compiled_procedure']);
});

test('insufficient-data trust yields SYSTEM2, probationary at least SYSTEM1_VERIFY', () => {
  const insufficient = adviseMode(input({ route: trustedRoute({ trustState: 'insufficient-data' }) }));
  assert.equal(insufficient.mode, MODES.SYSTEM2);
  assert.deepEqual(insufficient.reasons, ['trust_insufficient_data']);

  const probationary = adviseMode(input({ route: trustedRoute({ trustState: 'probationary' }) }));
  assert.equal(probationary.mode, MODES.SYSTEM1_VERIFY);
  assert.deepEqual(probationary.reasons, ['probationary_requires_verification']);

  // A high-demand probationary route still escalates all the way to SYSTEM2.
  const escalated = adviseMode(input({ route: trustedRoute({ trustState: 'probationary' }), novelty: 1, arousal: 1, predictionError: { recentMean: 1 }, value: { supportScore: 0 } }));
  assert.equal(escalated.mode, MODES.SYSTEM2);
});

test('unknown components count as maximal demand', () => {
  const advice = adviseMode({ route: trustedRoute(), riskLevel: 'low' });
  assert.deepEqual([...advice.unknownComponents].sort(), ['arousal', 'novelty', 'predictionError', 'uncertainty']);
  assert.equal(advice.demand, 1);
  assert.equal(advice.mode, MODES.SYSTEM2);
  // A malformed (out-of-range) component is unknown, not silently small.
  assert.deepEqual(adviseMode(input({ novelty: 5 })).unknownComponents, ['novelty']);
});

test('thresholds partition demand deterministically', () => {
  // Setting all four components to c makes demand exactly c (weights sum to 1).
  const at = (demand) => adviseMode({ route: trustedRoute(), riskLevel: 'low',
    predictionError: { recentMean: demand }, value: { supportScore: 1 - demand }, novelty: demand, arousal: demand });
  assert.equal(at(S1_MAX_DEMAND - 0.01).demand, 0.29);
  assert.equal(at(S1_MAX_DEMAND - 0.01).mode, MODES.SYSTEM1);
  assert.equal(at(S1_MAX_DEMAND).mode, MODES.SYSTEM1_VERIFY);
  assert.equal(at(S2_MIN_DEMAND - 0.01).mode, MODES.SYSTEM1_VERIFY);
  assert.equal(at(S2_MIN_DEMAND).mode, MODES.SYSTEM2);
  // Deterministic: same input, same output.
  assert.deepEqual(adviseMode(input()), adviseMode(input()));
});

test('advice never carries executes true or an allow verdict', () => {
  for (const riskLevel of ['low', 'medium', 'high', 'critical', 'unknown']) {
    const advice = adviseMode(input({ riskLevel }));
    assert.equal(advice.executes, false);
    assert.equal(advice.authority, 'ROUTING_ADVICE_ONLY');
    assert.ok(!Object.hasOwn(advice, 'decision') && !Object.hasOwn(advice, 'allow'));
  }
  // The router cannot lower risk: SYSTEM2 advice is still advice, not permission.
  assert.equal(adviseMode(input({ riskLevel: 'critical' })).authority, 'ROUTING_ADVICE_ONLY');
});

test('weights and thresholds are the frozen preregistration constants', () => {
  assert.deepEqual(WEIGHTS, { predictionError: 0.35, uncertainty: 0.25, novelty: 0.20, arousal: 0.20 });
  assert.equal(S1_MAX_DEMAND, 0.30);
  assert.equal(S2_MIN_DEMAND, 0.60);
  assert.ok(Object.isFrozen(WEIGHTS) && Object.isFrozen(MODES));
});

test('non-object input is rejected as advice, never as a permission', () => {
  for (const bad of [undefined, null, 42, 'route', []]) {
    const advice = adviseMode(bad);
    assert.equal(advice.mode, null);
    assert.deepEqual(advice.reasons, ['invalid_input']);
    assert.equal(advice.executes, false);
    assert.equal(advice.authority, 'ROUTING_ADVICE_ONLY');
  }
});
