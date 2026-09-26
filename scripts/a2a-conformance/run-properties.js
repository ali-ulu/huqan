'use strict';

const assert = require('node:assert/strict');

const { evaluateBoundedExchange } = require('./verifier');

const { EVALUATION_TIME, clone } = require('./run-support');
const { buildFixture } = require('./run-fixture');

function effectFailureCases() {
  const cases = [];
  const one = buildFixture();
  const replayed = new Set();
  const reserve = ({ replayKey }) => {
    if (replayed.has(replayKey)) return Object.freeze({ reserved: false });
    replayed.add(replayKey);
    return Object.freeze({ reserved: true });
  };
  const failedEffect = evaluateBoundedExchange({
    request: one.request, authority: one.authority, evaluationTime: EVALUATION_TIME,
    replayReserve: reserve, effect: () => { throw new Error('synthetic effect failure'); },
  });
  assert.deepEqual(failedEffect, { decision: 'block', reason: 'verification_failed' });
  const afterFailure = evaluateBoundedExchange({
    request: one.request, authority: one.authority, evaluationTime: EVALUATION_TIME,
    replayReserve: reserve, effect: () => Object.freeze({ shouldNotRun: true }),
  });
  assert.deepEqual(afterFailure, { decision: 'block', reason: 'replay_detected' });
  cases.push({
    caseId: 'effect_failure_keeps_replay_marker', expected: 'block/replay_detected after failed effect',
    actual: `${failedEffect.reason}/${afterFailure.reason}`, passed: true,
  });
  return cases;
}

function clockAdvanceCases() {
  const cases = [];
  const one = buildFixture();
  const replayed = new Set();
  const reserve = ({ replayKey }) => {
    if (replayed.has(replayKey)) return Object.freeze({ reserved: false });
    replayed.add(replayKey);
    return Object.freeze({ reserved: true });
  };
  const first = evaluateBoundedExchange({
    request: one.request, authority: one.authority, evaluationTime: one.authority.evaluationTime,
    replayReserve: reserve, effect: () => Object.freeze({ performed: true }),
  });
  const restartedAuthority = clone(one.authority);
  restartedAuthority.evaluationTime = '2026-08-11T12:01:00.000Z';
  const afterClockAdvance = evaluateBoundedExchange({
    request: one.request, authority: restartedAuthority, evaluationTime: restartedAuthority.evaluationTime,
    replayReserve: reserve, effect: () => Object.freeze({ shouldNotRun: true }),
  });
  assert.equal(first.decision, 'allow');
  assert.deepEqual(afterClockAdvance, { decision: 'block', reason: 'replay_detected' });
  cases.push({
    caseId: 'replay_survives_receiver_clock_advance', expected: 'block/replay_detected',
    actual: `${afterClockAdvance.decision}/${afterClockAdvance.reason}`, passed: true,
  });
  return cases;
}

function proxyInputCases() {
  const cases = [];
  const one = buildFixture();
  const proxiedRequest = new Proxy(one.request, {});
  const accessorRequest = clone(one.request);
  Object.defineProperty(accessorRequest, 'exchangeId', {
    enumerable: true,
    get: () => one.request.exchangeId,
  });
  for (const request of [proxiedRequest, accessorRequest]) {
    const outcome = evaluateBoundedExchange({
      request, authority: one.authority, evaluationTime: EVALUATION_TIME,
      replayReserve: () => Object.freeze({ reserved: true }), effect: () => Object.freeze({}),
    });
    assert.deepEqual(outcome, { decision: 'block', reason: 'exchange_shape_invalid' });
  }
  cases.push({
    caseId: 'proxy_and_accessor_inputs_rejected_before_verification',
    expected: 'block/exchange_shape_invalid', actual: 'block/exchange_shape_invalid', passed: true,
  });
  return cases;
}

module.exports = Object.freeze({ effectFailureCases, clockAdvanceCases, proxyInputCases });
