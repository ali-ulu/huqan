'use strict';

/**
 * COG-M9 value-ledger H1 characterization (#4063), run against the
 * preregistration in
 * docs/task-packs/cog-m9-value-ledger-preregistration-20261029.md.
 *
 * Every documented label (GAIN / HARM / NOT_CLEARED / INSUFFICIENT) is
 * exercised on a frozen, fixed corpus: the expected status, reason and label
 * were written into the preregistration before this test ran, and the two must
 * stay in lockstep. The corpus is a constant, not a task sample, so nothing
 * statistical is claimed. The runner is reached through the real CLI entry
 * (bin/huqan-cognitive-lab.js), opens no store, and the report must be
 * byte-identical across runs (no clock, no randomness).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '../bin/huqan-cognitive-lab.js');
const BASE = Date.UTC(2026, 9, 20, 0, 0, 0);

// The frozen corpus builder: monotone wall clock, one independent source group
// per row, so the fold and the paired delta read exactly the pinned inputs.
function corpus({ trainA = [], trainB = [], holdA = [], holdB = [] } = {}) {
  let clock = 0;
  let group = 0;
  const records = [];
  const add = (key, outcome, split) => {
    clock += 2;
    records.push({
      workspaceId: 'ws', key, decisionId: `d${String(clock).padStart(5, '0')}`,
      at: new Date(BASE + clock * 1000).toISOString(),
      availableAt: new Date(BASE + (clock + 1) * 1000).toISOString(),
      outcome, sourceGroup: `g${group++}`, sourceRefs: [`r${clock}`], split,
    });
  };
  for (const outcome of trainA) add('risk:a', outcome, 'train');
  for (const outcome of trainB) add('risk:b', outcome, 'train');
  for (const outcome of holdA) add('risk:a', outcome, 'holdout');
  for (const outcome of holdB) add('risk:b', outcome, 'holdout');
  return { workspaceId: 'ws', asOf: new Date(BASE + 999999 * 1000).toISOString(), records };
}

const C9 = Array(9).fill('confirmed');
const R9 = Array(9).fill('rollback');

// Preregistered frozen corpora and their expected labels (§5-6).
const FROZEN = Object.freeze({
  gain: {
    request: corpus({ trainA: C9, trainB: R9, holdA: C9, holdB: R9 }),
    expect: {
      status: 'MEASURED', reason: 'paired_gain_measured', label: 'GAIN',
      mean: 0.253897, lower: 0.212876, upper: 0.298331, eceNonInferior: true,
      coverage: { holdoutTotal: 18, covered: 18, uncovered: 0 },
    },
  },
  harm: {
    request: corpus({ trainA: C9, trainB: R9, holdA: R9, holdB: C9 }),
    expect: {
      status: 'MEASURED', reason: 'interval_upper_below_zero', label: 'HARM',
      mean: -0.228954, lower: -0.302556, upper: -0.160627, eceNonInferior: false,
      coverage: { holdoutTotal: 18, covered: 18, uncovered: 0 },
    },
  },
  mixed: {
    request: corpus({
      trainA: C9, trainB: R9,
      holdA: [...C9.slice(0, 3), ...R9.slice(0, 6)], holdB: [...R9.slice(0, 6), ...C9.slice(0, 3)],
    }),
    expect: {
      status: 'MEASURED', reason: 'interval_below_meaningful_effect', label: 'NOT_CLEARED',
      mean: -0.103982, lower: -0.240952, upper: 0.028015, eceNonInferior: false,
      coverage: { holdoutTotal: 18, covered: 18, uncovered: 0 },
    },
  },
  small: {
    request: corpus({ trainA: C9.slice(0, 3), holdA: C9.slice(0, 3) }),
    expect: {
      status: 'INSUFFICIENT', reason: 'sample_below_minimum', label: null,
      coverage: { holdoutTotal: 3, covered: 3, uncovered: 0 },
    },
  },
});

function writeRequest(t, request) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cog-m9-char-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'm9-request.json');
  fs.writeFileSync(file, JSON.stringify(request));
  return file;
}

function invokeCli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env } });
  let output;
  try { output = JSON.parse(result.stdout); } catch { output = null; }
  return { code: result.status, output, stderr: result.stderr };
}

test('every documented label matches its preregistered verdict', (t) => {
  for (const [name, { request, expect }] of Object.entries(FROZEN)) {
    const file = writeRequest(t, request);
    const result = invokeCli(['value-ledger', '--value-ledger-records', file]);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    const report = result.output;
    assert.ok(report, `${name}: valid JSON report expected`);
    assert.equal(report.schemaVersion, 'huqan-cognitive-lab-value-ledger-report-v1', name);
    assert.equal(report.status, expect.status, `${name} status`);
    assert.equal(report.reason, expect.reason, `${name} reason`);
    assert.deepEqual(report.coverage, expect.coverage, `${name} coverage`);
    // §5-6: the ledger never claims a gain and never measures general intelligence.
    assert.equal(report.assertsGain, false, `${name} assertsGain`);
    assert.equal(report.intelligenceGain, 'NOT_MEASURED', name);
    assert.equal(report.authority, 'SIGNAL_ONLY', name);
    if (expect.label === null) {
      assert.equal(report.h1, null, `${name} h1 must be null when not MEASURED`);
      continue;
    }
    assert.equal(report.h1.label, expect.label, `${name} label`);
    assert.equal(report.h1.eceNonInferior, expect.eceNonInferior, `${name} ece`);
    assert.equal(report.h1.mean.toFixed(6), expect.mean.toFixed(6), `${name} mean`);
    assert.equal(report.h1.lower.toFixed(6), expect.lower.toFixed(6), `${name} lower`);
    assert.equal(report.h1.upper.toFixed(6), expect.upper.toFixed(6), `${name} upper`);
    assert.equal(report.contract.seed, 40630, `${name} locked seed`);
    assert.equal(report.contract.minimumSamples, 10, `${name} locked minimum`);
  }
});

test('an empty corpus reports INSUFFICIENT rather than a fabricated measurement', (t) => {
  const file = writeRequest(t, { workspaceId: 'ws', asOf: new Date(BASE + 999999 * 1000).toISOString(), records: [] });
  const result = invokeCli(['value-ledger', '--value-ledger-records', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.status, 'INSUFFICIENT');
  assert.equal(result.output.reason, 'no_holdout_records');
  assert.equal(result.output.h1, null);
  assert.equal(result.output.assertsGain, false);
});

test('the report is byte-identical across runs through the real CLI entry', (t) => {
  const file = writeRequest(t, FROZEN.gain.request);
  const first = invokeCli(['value-ledger', '--value-ledger-records', file]);
  assert.equal(first.code, 0, first.stderr);
  const second = invokeCli(['value-ledger', '--value-ledger-records', file]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.stringify(first.output), JSON.stringify(second.output), 'the same corpus must yield the identical report');
});

test('a decision cannot leak its own outcome into its forecast', () => {
  const { walkForward } = require('../lib/cognitive-lab-m9-evaluator');
  const request = FROZEN.gain.request;
  const walk = walkForward(request.records, { workspaceId: request.workspaceId, asOf: request.asOf });
  // The first holdout decision sees only the 18 train rows: risk:a is 9/9
  // confirmed, so the ledger's prior is (9+1)/(9+2) = 10/11, never the later
  // holdout outcomes.
  assert.equal(walk.candidate[0].decisionId, 'd00038');
  assert.equal(walk.candidate[0].probability, 0.909091);
  // The key-independent base rate over the same window is (9+1)/(18+2) = 0.5.
  assert.equal(walk.baseline[0].probability, 0.5);
});

test('a missing request file fails closed before any store exists', () => {
  const missing = invokeCli(['value-ledger', '--value-ledger-records', path.join(os.tmpdir(), 'huqan-cog-m9-missing.json')]);
  assert.notEqual(missing.code, 0, 'a missing request file must fail closed');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'huqan-cog-m9-missing.json')), false);
});

test('the committed evidence matches the live evaluator for every case', () => {
  const { evaluateValueLedgerRequest } = require('../lib/cognitive-lab-m9-evaluator');
  const evidence = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../docs/task-packs/cog-m9-value-ledger-result-20261029.json'), 'utf8',
  ));
  const corpora = {
    gain: FROZEN.gain.request,
    harm: FROZEN.harm.request,
    not_cleared: FROZEN.mixed.request,
    insufficient: FROZEN.small.request,
    empty: { workspaceId: 'ws', asOf: new Date(BASE + 999999 * 1000).toISOString(), records: [] },
  };
  for (const [name, request] of Object.entries(corpora)) {
    const live = evaluateValueLedgerRequest(request);
    const recorded = evidence.cases[name];
    assert.ok(recorded, `${name}: the evidence must record this case`);
    assert.equal(recorded.status, live.status, `${name} status`);
    assert.equal(recorded.reason, live.reason, `${name} reason`);
    assert.deepEqual(recorded.coverage, live.coverage, `${name} coverage`);
    assert.deepEqual(recorded.h1, live.h1, `${name} h1`);
    assert.equal(recorded.assertsGain, false, `${name} assertsGain`);
    assert.equal(recorded.intelligenceGain, 'NOT_MEASURED', name);
  }
  assert.equal(evidence.assertsGain, false, 'the evidence itself must not claim a gain');
});
