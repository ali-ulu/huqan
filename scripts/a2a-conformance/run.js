'use strict';

const assert = require('node:assert/strict');

const { canonicalHash } = require('./verifier');

const { EVALUATION_TIME } = require('./run-support');
const { buildFixture } = require('./run-fixture');
const { NEGATIVE_CASES, mutated } = require('./run-cases');
const { invokeConsumer, cleanRoomCases, concurrentCases } = require('./run-consumer');
const { effectFailureCases, clockAdvanceCases, proxyInputCases } = require('./run-properties');

async function run() {
  const fixture = buildFixture();
  const positive = invokeConsumer(fixture.authority, [fixture.request, fixture.request]);
  assert.deepEqual(positive.results[0], {
    decision: 'allow', reason: 'ok', effect: { performed: true, effectCount: 1 },
  });
  assert.deepEqual(positive.results[1], { decision: 'block', reason: 'replay_detected' });
  assert.equal(positive.effectCount, 1, 'replay must not execute an effect');

  const cases = [
    { caseId: 'valid_exchange_once', expected: 'allow/ok', actual: 'allow/ok', passed: true },
    { caseId: 'replay_same_exchange', expected: 'block/replay_detected', actual: 'block/replay_detected', passed: true },
  ];
  cases.push(...cleanRoomCases(fixture));
  for (const [caseId, expectedReason, mutator] of NEGATIVE_CASES) {
    const specimen = mutated(mutator);
    const output = invokeConsumer(specimen.authority, [specimen.request]);
    const actual = output.results[0];
    assert.deepEqual(actual, { decision: 'block', reason: expectedReason }, caseId);
    assert.equal(output.effectCount, 0, `${caseId}: rejected exchange must have zero effects`);
    assert.equal(Object.hasOwn(actual, 'effect'), false, `${caseId}: rejected exchange must have no effect output`);
    cases.push({
      caseId,
      expected: `block/${expectedReason}`,
      actual: `${actual.decision}/${actual.reason}`,
      passed: true,
    });
  }
  cases.push(...effectFailureCases(), ...clockAdvanceCases(), ...proxyInputCases());
  cases.push(...await concurrentCases());
  const report = {
    schemaVersion: 'v5-d6-a2a-conformance-report-v1',
    suiteId: 'V5-D6',
    transport: 'local-child-process-stdio',
    productionTransportClaimed: false,
    evaluationTime: EVALUATION_TIME,
    caseCount: cases.length,
    passed: cases.length,
    failed: 0,
    effectsObserved: 1,
    rejectedEffectsObserved: 0,
    cases,
    verdict: 'V5_D6_BOUNDED_A2A_EXCHANGE_SUFFICIENT',
    nonClaims: [
      'production_transport_not_implemented',
      'network_discovery_routing_and_delivery_not_implemented',
      'effect_payload_bytes_not_exchanged_only_signed_hash_reference',
    ],
  };
  process.stdout.write(`${JSON.stringify({ report, reportSha256: canonicalHash(report) })}\n`);
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

// The route test builds its exchanges from this same generator (P0-B). Two
// generators would mean the route could pass against an envelope the
// conformance suite would never produce.
module.exports = Object.freeze({ buildFixture });
