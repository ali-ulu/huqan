'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildReferenceFixture,
  runReferenceBenchmark,
} = require('./inference-semi-naive');

test('reference fixture is deterministic', () => {
  assert.deepEqual(
    buildReferenceFixture({ noiseFacts: 20, stages: 5 }),
    buildReferenceFixture({ noiseFacts: 20, stages: 5 }),
  );
});

test('reference benchmark demonstrates delta driving instead of full rescans', () => {
  const report = runReferenceBenchmark({ noiseFacts: 200, stages: 12 });

  assert.equal(report.status, 'complete');
  assert.equal(report.stoppedReason, 'fixpoint');
  assert.equal(report.derivedFacts, 12);
  assert.equal(report.driverFactVisits, 12);
  assert.equal(report.rounds, 13);
  assert.ok(report.naiveFullRescanEstimate > report.driverFactVisits * 100);
  assert.ok(report.driverToNaiveRatio < 0.01);
});
