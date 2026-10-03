'use strict';

/**
 * Decision-probability calibration tests (#3308, slice 3308-P1).
 *
 * The first group exercises the real store: an explicit probability recorded
 * before the outcome, joined to the existing prediction/outcome ledger, and
 * classified observed/censored/missing without ever scoring a missing outcome
 * as success. The mutation group pins the refusals -- a probability written
 * after the outcome is rejected, a duplicate replays, a bad p fails closed.
 *
 * The analytic group fixes the numbers. A hand-computed Brier and ECE pin the
 * formulas, and raising a wrong high p must worsen Brier, so the score is not a
 * mirror of the implementation. The last group proves the fail-closed contract:
 * no data is INSUFFICIENT, a measurement error is diagnosed rather than scored,
 * and no result ever asserts a gain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  PROBABILITY_SCHEMA_VERSION,
  ELEVEN_BINS,
  RECORD_STATUS,
  CALIBRATION_STATUS,
  METRIC_DIRECTION,
  recordDecisionProbability,
  readCalibratedRecords,
  calibrate,
} = require('../lib/cognitive-lab-probability-calibration');
const { recordPrediction, recordOutcome } = require('../lib/prediction-outcome-pairs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-probcal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryGraph(dir) {
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

const AT = '2026-01-01T00:00:00.000Z';
const AT2 = '2026-01-02T00:00:00.000Z';

function observed({ decisionId, probability, y }) {
  return { decisionId, measurementId: 'm', probability, status: RECORD_STATUS.OBSERVED, y, outcome: y === 1 ? 'confirmed' : 'incident' };
}

test('an explicit probability is frozen before the outcome and joined to its decision', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordPrediction(graph, { decisionId: 'd1', score: 80, actionClass: 'write', at: AT });
  const recorded = recordDecisionProbability(graph, {
    measurementId: 'm1', decisionId: 'd1', probability: 0.2, at: AT,
  });
  assert.equal(recorded.replayed, false);
  assert.equal(recorded.probability, 0.2);

  const before = readCalibratedRecords(graph, { measurementId: 'm1' });
  assert.equal(before.length, 1);
  assert.equal(before[0].status, RECORD_STATUS.CENSORED);
  assert.equal(before[0].y, null);

  recordOutcome(graph, { decisionId: 'd1', outcome: 'confirmed', idempotencyKey: 'o1', at: AT2 });
  const after = readCalibratedRecords(graph, { measurementId: 'm1' });
  assert.equal(after[0].status, RECORD_STATUS.OBSERVED);
  assert.equal(after[0].y, 1);
  assert.equal(after[0].probability, 0.2);

  const replay = recordDecisionProbability(graph, {
    measurementId: 'm1', decisionId: 'd1', probability: 0.9, at: AT,
  });
  assert.equal(replay.replayed, true);
  assert.equal(readCalibratedRecords(graph, { measurementId: 'm1' })[0].probability, 0.2);
});

test('a probability cannot be written after the outcome is observed', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordPrediction(graph, { decisionId: 'd2', score: 80, at: AT });
  recordOutcome(graph, { decisionId: 'd2', outcome: 'incident', idempotencyKey: 'o2', at: AT2 });
  assert.throws(
    () => recordDecisionProbability(graph, { measurementId: 'm1', decisionId: 'd2', probability: 0.4, at: AT }),
    /already has an outcome/,
  );
  assert.equal(readCalibratedRecords(graph, { measurementId: 'm1' }).length, 0);
});

test('a probability with no base prediction is missing, not success', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordDecisionProbability(graph, { measurementId: 'm1', decisionId: 'ghost', probability: 0.8, at: AT });
  const records = readCalibratedRecords(graph, { measurementId: 'm1' });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, RECORD_STATUS.MISSING);
  assert.equal(records[0].y, null);
  const report = calibrate(records);
  assert.equal(report.status, CALIBRATION_STATUS.INSUFFICIENT);
  assert.equal(report.measurement.missing, 1);
  assert.equal(report.measurement.observed, 0);
});

test('a censored outcome window is never scored as success', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordPrediction(graph, { decisionId: 'd3', score: 50, at: AT });
  recordDecisionProbability(graph, { measurementId: 'm1', decisionId: 'd3', probability: 0.5, at: AT });
  recordOutcome(graph, { decisionId: 'd3', outcome: 'censored', idempotencyKey: 'o3', at: AT2 });
  const records = readCalibratedRecords(graph, { measurementId: 'm1' });
  assert.equal(records[0].status, RECORD_STATUS.CENSORED);
  assert.equal(records[0].y, null);
  const report = calibrate(records);
  assert.equal(report.measurement.censored, 1);
  assert.equal(report.measurement.observed, 0);
  assert.equal(report.brier, null);
});

test('measurements are scoped by their measurement id', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordPrediction(graph, { decisionId: 'd4', score: 50, at: AT });
  recordPrediction(graph, { decisionId: 'd5', score: 50, at: AT });
  recordDecisionProbability(graph, { measurementId: 'm1', decisionId: 'd4', probability: 0.3, at: AT });
  recordDecisionProbability(graph, { measurementId: 'm2', decisionId: 'd5', probability: 0.7, at: AT });
  assert.deepEqual(readCalibratedRecords(graph, { measurementId: 'm1' }).map((r) => r.decisionId), ['d4']);
  assert.deepEqual(readCalibratedRecords(graph, { measurementId: 'm2' }).map((r) => r.decisionId), ['d5']);
  assert.equal(readCalibratedRecords(graph).length, 2);
});

test('a probability outside [0, 1] and blank identity fail closed', (t) => {
  const graph = memoryGraph(tempDir(t));
  assert.throws(() => recordDecisionProbability(graph, { measurementId: 'm', decisionId: 'd', probability: 1.5 }), /between 0 and 1/);
  assert.throws(() => recordDecisionProbability(graph, { measurementId: '', decisionId: 'd', probability: 0.5 }), /measurementId/);
  assert.throws(() => recordDecisionProbability(graph, { measurementId: 'm', decisionId: 'd', probability: NaN }), /between 0 and 1/);
  assert.throws(() => readCalibratedRecords(null), /graph/);
});

test('Brier, reliability bins and ECE match a hand-computed fixture', () => {
  const records = [
    observed({ decisionId: 'a', probability: 0.9, y: 0 }),
    observed({ decisionId: 'b', probability: 0.8, y: 0 }),
    observed({ decisionId: 'c', probability: 0.1, y: 1 }),
    observed({ decisionId: 'd', probability: 0.2, y: 1 }),
  ];
  const report = calibrate(records);
  // mean squared error: (0.81 + 0.64 + 0.81 + 0.64) / 4
  assert.ok(Math.abs(report.brier - 0.725) < 1e-12, `brier=${report.brier}`);
  // ECE: (|0.9-0| + |0.8-0| + |0.1-1| + |0.2-1|) / 4
  assert.ok(Math.abs(report.ece - 0.85) < 1e-12, `ece=${report.ece}`);
  assert.equal(report.measurement.observed, 4);
  assert.equal(report.bins.length, ELEVEN_BINS.length);
  assert.equal(report.bins[8].count, 1); // [0.8, 0.9)
  assert.equal(report.bins[8].observedRate, 0);
  assert.equal(report.bins[1].count, 1); // [0.1, 0.2)
  assert.equal(report.bins[1].observedRate, 1);
  // four observed records is below the locked minimum, so no level is asserted
  assert.equal(report.status, CALIBRATION_STATUS.INSUFFICIENT);
  assert.equal(report.reliable, false);
  assert.equal(report.assertsGain, false);
});

test('a wrong high probability worsens Brier', () => {
  // The event is "the decision was confirmed"; an adverse outcome is y = 0.
  // Stating a high p for a decision that turned out adverse must cost more.
  const base = [
    observed({ decisionId: 'a', probability: 0.2, y: 0 }),
    observed({ decisionId: 'b', probability: 0.2, y: 0 }),
    observed({ decisionId: 'c', probability: 0.2, y: 0 }),
    observed({ decisionId: 'd', probability: 0.2, y: 0 }),
  ];
  const inflated = base.map((record, index) => (index === 0 ? { ...record, probability: 0.95 } : record));
  const good = calibrate(base).brier;
  const bad = calibrate(inflated).brier;
  assert.ok(Math.abs(good - 0.04) < 1e-12, `good=${good}`);
  assert.ok(bad > good, `inflated brier ${bad} should exceed ${good}`);
});

test('a wrong high probability is not hidden by coarser bins', () => {
  // Overall the mean forecast equals the observed rate, so one coarse bin
  // reports ECE 0; the miscalibration only shows up within finer bins.
  const base = [
    observed({ decisionId: 'a', probability: 0.1, y: 0 }),
    observed({ decisionId: 'b', probability: 0.9, y: 1 }),
    observed({ decisionId: 'c', probability: 0.1, y: 1 }),
    observed({ decisionId: 'd', probability: 0.9, y: 0 }),
  ];
  const oneBin = calibrate(base, { bins: [1] });
  const detailed = calibrate(base);
  assert.equal(oneBin.ece, 0);
  assert.ok(Math.abs(detailed.ece - 0.4) < 1e-12, `ece=${detailed.ece}`);
});

test('no data is INSUFFICIENT, never a number', () => {
  const report = calibrate([]);
  assert.equal(report.status, CALIBRATION_STATUS.INSUFFICIENT);
  assert.equal(report.brier, null);
  assert.equal(report.bins, null);
  assert.equal(report.ece, null);
  assert.equal(report.reason, 'no_data');
  assert.equal(report.assertsGain, false);
});

test('a measurement error is diagnosed, not scored', () => {
  const records = [
    observed({ decisionId: 'a', probability: 0.5, y: 1 }),
    { decisionId: 'b', measurementId: 'm', probability: 0.5, status: RECORD_STATUS.MEASUREMENT_ERROR, y: null, outcome: 'exploded' },
  ];
  const report = calibrate(records);
  assert.equal(report.measurement.measurement_error, 1);
  assert.equal(report.measurement.observed, 1);
  assert.ok(Number.isFinite(report.brier));
});

test('a report is measured only when enough observed samples exist and never asserts gain', () => {
  const records = Array.from({ length: 12 }, (_, index) => observed({
    decisionId: `s${index}`, probability: index % 2 === 0 ? 0.2 : 0.8, y: index % 2 === 0 ? 1 : 0,
  }));
  const report = calibrate(records);
  assert.equal(report.status, CALIBRATION_STATUS.MEASURED);
  assert.equal(report.reliable, true);
  assert.equal(report.direction, METRIC_DIRECTION);
  assert.equal(report.schemaVersion, PROBABILITY_SCHEMA_VERSION);
  assert.equal(report.assertsGain, false);
  // two wrong-at-opposite-ends bins: |0.2 - 1| and |0.8 - 0|, weighted 6/12 each
  assert.ok(Math.abs(report.ece - 0.8) < 1e-12, `ece=${report.ece}`);
});

test('malformed bins and a bad minimum fail closed', () => {
  assert.throws(() => calibrate([], { bins: [0.5, 0.5] }), /strictly increasing/);
  assert.throws(() => calibrate([], { bins: [0.5] }), /final bin edge must be 1/);
  assert.throws(() => calibrate([], { bins: [0.5, 1.5] }), /in \(0, 1\]/);
  assert.throws(() => calibrate([], { bins: [0.5, 0.9] }), /final bin edge must be 1/);
  assert.throws(() => calibrate([], { minObserved: 0 }), /positive integer/);
});
