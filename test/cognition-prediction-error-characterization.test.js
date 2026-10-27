'use strict';

/**
 * COG-M2 prediction-error characterization (#4061), run against the
 * preregistration in docs/task-packs/cog-m2-prediction-error-preregistration-20261027.md.
 *
 * Every documented outcome class (MEASURED / ABSTAIN / REJECT) is exercised
 * once per kind with an open, fixed oracle: the expected status, reason and
 * signed error were written into the preregistration before this test ran and
 * the two must stay in lockstep. The records are constants, not a task
 * sample, so nothing statistical is claimed. The runner is reached through
 * the real CLI entry (bin/huqan-cognitive-lab.js), opens no store, and the
 * report must be byte-identical across runs (no clock, no randomness).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '../bin/huqan-cognitive-lab.js');
const AT_BASE = Date.parse('2026-10-19T10:00:00Z');
const at = (n) => new Date(AT_BASE + n * 1000).toISOString();

// The frozen oracle (preregistration §2-6): one row per documented class.
const ORACLE = Object.freeze([
  { decisionId: 'dec_01', kind: 'risk', key: 'rule:ws/r1', score: 80, outcome: 'incident', at: at(1) },
  { decisionId: 'dec_02', kind: 'risk', key: 'rule:ws/r1', score: 20, outcome: 'confirmed', at: at(2) },
  { decisionId: 'dec_03', kind: 'risk', key: 'rule:ws/r2', score: 20, outcome: 'rollback', at: at(3) },
  { decisionId: 'dec_04', kind: 'risk', key: 'rule:ws/r2', score: 80, outcome: 'confirmed', at: at(4) },
  { decisionId: 'dec_05', kind: 'risk', key: 'rule:ws/r3', score: 80, outcome: 'censored', at: at(5) },
  { decisionId: 'dec_06', kind: 'risk', key: 'rule:ws/r3', score: null, outcome: 'incident', at: at(6) },
  { decisionId: 'dec_07', kind: 'probability', key: 'cap:stored-ab', p: 0.9, y: 0, probabilitySource: 'cognitive-lab-comparison', at: at(7) },
  { decisionId: 'dec_08', kind: 'probability', key: 'cap:stored-cd', p: 0.9, y: 1, probabilitySource: 'cognitive-lab-comparison', at: at(8) },
  { decisionId: 'dec_09', kind: 'probability', key: 'cap:stored-ef', p: 0.9, y: 0, at: at(9) },
  { decisionId: 'dec_10', kind: 'probability', key: 'cap:stored-gh', p: 1.2, y: 0, probabilitySource: 'cognitive-lab-comparison', at: at(10) },
  { decisionId: 'dec_11', kind: 'state', key: 'frame:f1|act:a', failure: { status: 'CONFIRMED' }, keyCount: 4, at: at(11) },
  { decisionId: 'dec_12', kind: 'state', key: 'frame:f1|act:b', failure: { status: 'MISMATCH', differences: ['goal', 'confidence'] }, keyCount: 4, at: at(12) },
  { decisionId: 'dec_13', kind: 'state', key: 'frame:f2|act:a', failure: { status: 'UNKNOWN' }, keyCount: 4, at: at(13) },
  { decisionId: 'dec_14', kind: 'state', key: 'frame:f2|act:b', failure: { status: 'MISMATCH', differences: ['goal'] }, keyCount: 0, at: at(14) },
  { decisionId: 'dec_15', kind: 'effect', key: 'tool:edit', expected: 'modified', observed: 'modified', at: at(15) },
  { decisionId: 'dec_16', kind: 'effect', key: 'tool:edit', expected: 'modified', observed: 'unchanged', at: at(16) },
  { decisionId: 'dec_17', kind: 'effect', key: 'tool:edit', expected: 'modified', observed: 'indeterminate', at: at(17) },
  { decisionId: 'dec_18', kind: 'vibes', key: 'rule:ws/r9', at: at(18) },
  { decisionId: 'dec_19', kind: 'probability', key: 'cap:stored-ij', p: 0.5, y: 1, probabilitySource: 'cognitive-lab-comparison', z: 1, at: at(19) },
]);

// Preregistered expected (status, reason) per record, by decisionId.
const EXPECTED = Object.freeze({
  dec_01: { status: 'MEASURED', reason: 'high_estimate_met_adverse_outcome', signedError: 0 },
  dec_02: { status: 'MEASURED', reason: 'low_estimate_confirmed', signedError: 0 },
  dec_03: { status: 'MEASURED', reason: 'missed_adverse_outcome', signedError: 1 },
  dec_04: { status: 'MEASURED', reason: 'false_alarm', signedError: -1 },
  dec_05: { status: 'ABSTAIN', reason: 'outcome_unknown_or_censored' },
  dec_06: { status: 'ABSTAIN', reason: 'prediction_unscored' },
  dec_07: { status: 'MEASURED', reason: 'observed_outcome_differs', signedError: -0.9 },
  dec_08: { status: 'MEASURED', reason: 'observed_outcome_differs', signedError: 0.1 },
  dec_09: { status: 'ABSTAIN', reason: 'probability_source_missing' },
  dec_10: { status: 'REJECT', reason: 'invalid_probability' },
  dec_11: { status: 'MEASURED', reason: 'state_confirmed', signedError: 0 },
  dec_12: { status: 'MEASURED', reason: 'state_mismatch', signedError: 0.5 },
  dec_13: { status: 'ABSTAIN', reason: 'state_prediction_unknown' },
  dec_14: { status: 'REJECT', reason: 'invalid_key_count' },
  dec_15: { status: 'MEASURED', reason: 'effect_as_expected', signedError: 0 },
  dec_16: { status: 'MEASURED', reason: 'effect_differs', signedError: 1 },
  dec_17: { status: 'ABSTAIN', reason: 'effect_indeterminate' },
  dec_18: { status: 'REJECT', reason: 'unknown_kind' },
  dec_19: { status: 'REJECT', reason: 'unknown_field:z' },
});

function writeRecords(t, records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cog-m2-char-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'm2-records.json');
  fs.writeFileSync(file, JSON.stringify({ records }));
  return file;
}

function invokeCli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env } });
  let output;
  try { output = JSON.parse(result.stdout); } catch { output = null; }
  return { code: result.status, output, stderr: result.stderr };
}

test('every documented outcome class matches its preregistered label', (t) => {
  const file = writeRecords(t, ORACLE);
  const result = invokeCli(['prediction-error', '--prediction-error-records', file]);
  assert.equal(result.code, 0, result.stderr);
  const report = result.output;
  assert.ok(report, 'valid JSON report expected');
  assert.equal(report.schemaVersion, 'huqan-cognitive-lab-prediction-error-report-v1');
  assert.equal(report.status, 'MEASURED');
  const section = report.predictionErrors;
  assert.equal(section.count, 19);
  assert.equal(section.measured, 10);
  assert.equal(section.abstained, 5);
  assert.equal(section.rejected, 4);
  const mismatches = section.results
    .filter((row) => { const expected = EXPECTED[row.decisionId]; return !expected || row.status !== expected.status || row.reason !== expected.reason; })
    .map((row) => row.decisionId);
  assert.deepEqual(mismatches, [], 'preregistered label mismatch');
  // Open signed-error oracle for the MEASURED rows (preregistration §2-5).
  const signed = Object.fromEntries(section.results.map((row) => [row.decisionId, row.magnitude]));
  for (const [decisionId, expected] of Object.entries(EXPECTED)) {
    if (expected.status !== 'MEASURED') continue;
    assert.equal(signed[decisionId], Math.abs(expected.signedError), `${decisionId} magnitude`);
  }
  assert.equal(section.summary.count, 10);
  assert.equal(section.summary.abstained, 5);
  assert.equal(section.summary.meanMagnitude, 0.45);
  assert.deepEqual(Object.keys(section.perKind).sort(), ['effect', 'probability', 'risk', 'state', 'vibes']);
  assert.equal(section.perKind.risk.count, 6);
  assert.equal(section.perKind.probability.rejected, 2);
  assert.deepEqual(section.perKind.vibes, { count: 1, measured: 0, abstained: 0, rejected: 1 });
});

test('the report is byte-identical across runs through the real CLI entry', (t) => {
  const file = writeRecords(t, ORACLE);
  const first = invokeCli(['prediction-error', '--prediction-error-records', file]);
  assert.equal(first.code, 0, first.stderr);
  const second = invokeCli(['prediction-error', '--prediction-error-records', file]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.stringify(first.output), JSON.stringify(second.output), 'the same records must yield the identical report');
});

test('an empty record set reports INSUFFICIENT and a missing file fails closed', (t) => {
  const empty = writeRecords(t, []);
  const result = invokeCli(['prediction-error', '--prediction-error-records', empty]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.status, 'INSUFFICIENT');
  assert.equal(result.output.predictionErrors.count, 0);
  const missing = invokeCli(['prediction-error', '--prediction-error-records', path.join(os.tmpdir(), 'huqan-cog-m2-missing.json')]);
  assert.equal(missing.code !== 0, true, 'a missing request file must fail closed');
});
