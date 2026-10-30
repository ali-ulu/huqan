'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');
const {
  digest, write, commit, installArith, installString, createWrongWriteCounter, run,
  sumCpu, isCpuComplete, cpuSampleComplete,
} = require('./helpers/coder-g3-cohort-fixtures');

// Preregistration: docs/task-packs/coder-learning-g3-power-cost-preregistration-20261030.md
// Thresholds were locked before this evaluation ever ran; they mirror §5/§7 there.
const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/coder-learning-g3-power-cost-preregistration-20261030.md',
  budget: 8,
  holdoutPerFamily: 5,
  minimumSamples: 10,
  repeats: 3,
  minEffect: { process: 1.0, wallMs: 100, cpuMs: 100 },
  wrongWriteTolerance: 0,
});

const Z_ALPHA = 1.96; // alpha 0.05, two-sided
const Z_POWER = 0.84; // power 0.8

// §5, frozen: the same formula M9 uses (lib/cognitive-lab-m9-holdout.js), per
// metric. The process metric is a deterministic integer saving, so its sigma is
// 0 and the declared minimum sample count is the binding constraint; the
// wall-time and CPU metrics carry run noise, so their sigma can require more.
function requiredSample(sigma, minEffect) {
  return Math.max(CONTRACT.minimumSamples,
    Math.ceil(((Z_ALPHA + Z_POWER) * sigma / minEffect) ** 2));
}

function sampleSd(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// §7/§8 verdict vocabulary, mirroring the #4380 eval: a metric verdict
// classifies the measured value, and an unmeasured value stays NOT_MEASURED.
function classifyGainVerdict(gain, gatesPass) {
  if (!Number.isFinite(gain)) return 'NOT_MEASURED';
  return gain > 0 && gatesPass ? 'GAIN' : 'INSUFFICIENT';
}

// §4 corpus — a slice independent of the consumed #4380 cohort. Family A is
// arithmetic-expression (buggy `x => x + 1`, target `x % 2`); family B is
// string-expression (buggy `p.toUpperCase()`, target `p.trim().toLowerCase()`).
// Calibration tasks feed only sigma; holdout tasks feed the power verdict.
const ARITH_TRAIN = { name: 'train-a', parameter: 'n', examples: [0, 2, 4], checks: [5, 8] };
const ARITH_CALIB = [
  { name: 'calib-a', parameter: 'seed', examples: [0, 6, 8], checks: [13, 20] },
  { name: 'calib-b', parameter: 'base', examples: [0, 10, 12], checks: [15, 26] },
  { name: 'calib-c', parameter: 'start', examples: [0, 14, 18], checks: [21, 30] },
];
const ARITH_HOLDOUT = [
  { name: 'pow-one', parameter: 'k', examples: [0, 22, 26], checks: [33, 40] },
  { name: 'pow-two', parameter: 'm', examples: [0, 30, 34], checks: [37, 44] },
  { name: 'pow-three', parameter: 'q', examples: [0, 38, 42], checks: [45, 52] },
  { name: 'pow-four', parameter: 'r', examples: [0, 46, 50], checks: [53, 60] },
  { name: 'pow-five', parameter: 's', examples: [0, 54, 58], checks: [61, 68] },
];
const ARITH_NOVEL = { name: 'novel', parameter: 'next', examples: [0, 1, 2], checks: [7, 11] };
const ARITH_REGRESSION = { name: 'regression', parameter: 'stream', examples: [0, 8, 14], checks: [31, 44] };

const STRING_OLD = 'function clean(value) { return value.toUpperCase(); }';
const STRING_TRAIN = { name: 'train-b', fn: 'clean', parameter: 'value',
  examples: [[' red ', 'red'], [' blue ', 'blue'], ['', '']],
  checks: [[' RED ', 'red'], [' BLUE ', 'blue']] };
const STRING_HOLDOUT = [
  { name: 'fold-one', fn: 'normalize', parameter: 'raw',
    examples: [[' héllo ', 'héllo'], [' world ', 'world'], ['', '']],
    checks: [[' HÉLLO ', 'héllo'], [' WORLD ', 'world']] },
  { name: 'fold-two', fn: 'tidy', parameter: 'item',
    examples: [[' green ', 'green'], [' yellow ', 'yellow'], ['', '']],
    checks: [[' GREEN ', 'green'], [' YELLOW ', 'yellow']] },
  { name: 'fold-three', fn: 'canonical', parameter: 'entry',
    examples: [[' purple ', 'purple'], [' orange ', 'orange'], ['', '']],
    checks: [[' PURPLE ', 'purple'], [' ORANGE ', 'orange']] },
  { name: 'fold-four', fn: 'slug', parameter: 'title',
    examples: [[' black ', 'black'], [' white ', 'white'], ['', '']],
    checks: [[' BLACK ', 'black'], [' WHITE ', 'white']] },
  { name: 'fold-five', fn: 'key', parameter: 'token',
    examples: [[' silver ', 'silver'], [' golden ', 'golden'], ['', '']],
    checks: [[' SILVER ', 'silver'], [' GOLDEN ', 'golden']] },
];

const ARITH_QUALIFY = { drift: 'qualify/drift.md', ambiguous: 'qualify/ambiguous.md' };
const STRING_QUALIFY = { drift: 'qualify/string-drift.md', ambiguous: 'qualify/string-ambiguous.md' };

// The coverage gate needs the `ambiguous` code to fire for this family, which
// only happens when the training procedure's `oldText` (`<parameter> + 1`)
// appears twice in the ambiguous fixture. Deriving it from the training
// parameter keeps the fixture and the corpus from drifting apart.
const ARITH_AMBIGUOUS = `${ARITH_TRAIN.parameter} + 1\n${ARITH_TRAIN.parameter} + 1`;

function seedRoots(parent, label) {
  const roots = { baseline: path.join(parent, `${label}-baseline`), learned: path.join(parent, `${label}-learned`) };
  for (const root of Object.values(roots)) {
    fs.mkdirSync(root);
    write(root, '.gitignore', '*.json\n*.db*\n.huqan/\n');
    write(root, ARITH_QUALIFY.drift, 'no matching expression');
    write(root, ARITH_QUALIFY.ambiguous, ARITH_AMBIGUOUS);
    write(root, STRING_QUALIFY.drift, 'no supported function');
    write(root, STRING_QUALIFY.ambiguous, `${STRING_OLD}\n${STRING_OLD}\n`);
    installArith(root, ARITH_TRAIN);
    installString(root, STRING_TRAIN);
    execFileSync('git', ['init', '-qb', 'feat/g3-power'], { cwd: root, stdio: 'pipe' });
    commit(root);
  }
  return roots;
}

function markTraining(root, name, qualify, memoryFile) {
  const file = path.join(root, `${name}.json`);
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  task.qualificationPaths = [qualify.drift, qualify.ambiguous];
  task.synthesis.rememberFile = memoryFile;
  fs.writeFileSync(file, JSON.stringify(task));
}

// Trains both families in the learned root and returns the training cost. The
// memory file names are per-run so repeated passes in the same parent cannot
// collide on the single-use marker.
function trainLearned(roots, label, cpuDir) {
  markTraining(roots.learned, ARITH_TRAIN.name, ARITH_QUALIFY, '.huqan/coder/candidates/parity.json');
  markTraining(roots.learned, STRING_TRAIN.name, STRING_QUALIFY, '.huqan/coder/candidates/string.json');
  const arith = run(roots.learned, ARITH_TRAIN.name, '--synthesize',
    { cpuLog: path.join(cpuDir, `${label}-train-a.jsonl`) });
  assert.equal(arith.result.data.outcome, 'applied_tested', JSON.stringify(arith.result));
  commit(roots.learned);
  const string = run(roots.learned, STRING_TRAIN.name, '--synthesize',
    { cpuLog: path.join(cpuDir, `${label}-train-b.jsonl`) });
  assert.equal(string.result.data.outcome, 'applied_tested', JSON.stringify(string.result));
  commit(roots.learned);
  const cpuMs = cpuSampleComplete(arith) && cpuSampleComplete(string)
    ? sumCpu(arith.cpu) + sumCpu(string.cpu) : null;
  return { wallMs: arith.wallMs + string.wallMs, cpuMs };
}

// One paired pass over a task list. Returns per-task rows and totals for both
// arms, with the wrong-write counter accumulated into the caller's counter.
function pairedPass(roots, items, install, label, cpuDir, wrongWrites) {
  const rows = [];
  let baselineWallMs = 0, learnedWallMs = 0, baselineCpuMs = 0, learnedCpuMs = 0;
  let cpuMeasured = true;
  for (const item of items) {
    const baselineFixture = install(roots.baseline, item);
    const learnedFixture = install(roots.learned, item);
    assert.equal(baselineFixture.taskHash, learnedFixture.taskHash);
    assert.equal(baselineFixture.testHash, learnedFixture.testHash);
    assert.equal(baselineFixture.content, learnedFixture.content);
    for (const root of Object.values(roots)) commit(root);
    const baseline = run(roots.baseline, item.name, '--synthesize',
      { cpuLog: path.join(cpuDir, `${label}-${item.name}-baseline.jsonl`) });
    const learned = run(roots.learned, item.name, '--adapt-memory',
      { cpuLog: path.join(cpuDir, `${label}-${item.name}-learned.jsonl`) });
    for (const row of [baseline, learned]) {
      assert.equal(row.result.data.outcome, 'applied_tested', JSON.stringify(row));
      assert.ok(row.processes > 0 && row.processes <= CONTRACT.budget);
      assert.equal(row.result.data.attempts.length, row.processes);
      assert.equal(row.result.data.record.observedVerification.ok, true);
    }
    assert.equal(fs.readFileSync(path.join(roots.baseline, `src/${item.name}.js`), 'utf8'),
      fs.readFileSync(path.join(roots.learned, `src/${item.name}.js`), 'utf8'));
    wrongWrites.assertChangedPaths(baseline.changed, [`src/${item.name}.js`], `${label} ${item.name} baseline`);
    wrongWrites.assertChangedPaths(learned.changed, [`src/${item.name}.js`], `${label} ${item.name} learned`);
    const baselineCpu = sumCpu(baseline.cpu), learnedCpu = sumCpu(learned.cpu);
    if (!cpuSampleComplete(baseline) || !cpuSampleComplete(learned)) cpuMeasured = false;
    rows.push({ task: item.name, taskHash: baselineFixture.taskHash,
      baselineProcesses: baseline.processes, learnedProcesses: learned.processes,
      processDelta: baseline.processes - learned.processes,
      wallDeltaMs: Math.round(baseline.wallMs - learned.wallMs),
      cpuDeltaMs: baselineCpu === null || learnedCpu === null ? null : Math.round(baselineCpu - learnedCpu),
      baselineWallMs: Math.round(baseline.wallMs), learnedWallMs: Math.round(learned.wallMs),
      baselineCpuMs: baselineCpu === null ? null : Math.round(baselineCpu),
      learnedCpuMs: learnedCpu === null ? null : Math.round(learnedCpu) });
    baselineWallMs += baseline.wallMs; learnedWallMs += learned.wallMs;
    baselineCpuMs += baselineCpu || 0; learnedCpuMs += learnedCpu || 0;
  }
  // An incomplete CPU sample must not read as a measured total: report `null`
  // totals when any row was unmeasured, so a partial log cannot bias the median.
  return { rows, baselineWallMs, learnedWallMs,
    baselineCpuMs: cpuMeasured ? baselineCpuMs : null,
    learnedCpuMs: cpuMeasured ? learnedCpuMs : null,
    cpuMeasured };
}

test('preregistered G3 power + repeated cost: the cohort is powered and cost is measured across repeats', t => {
  const wrongWrites = createWrongWriteCounter();
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-power-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const cpuDir = path.join(parent, 'cpu');
  fs.mkdirSync(cpuDir);

  // Pass 1 is the measurement pass: it yields sigma (calibration), the holdout
  // process gain and the power verdict, and the first cost sample.
  const pass1Roots = seedRoots(parent, 'p1');
  const training1 = trainLearned(pass1Roots, 'p1', cpuDir);
  const calib = pairedPass(pass1Roots, ARITH_CALIB, installArith, 'calib', cpuDir, wrongWrites);
  const holdout1 = pairedPass(pass1Roots, ARITH_HOLDOUT, installArith, 'p1-arith', cpuDir, wrongWrites);
  const holdout1b = pairedPass(pass1Roots, STRING_HOLDOUT, installString, 'p1-string', cpuDir, wrongWrites);

  // §5 power, per metric: sigma from the calibration slice's paired deltas, then
  // the required sample for the frozen effect and the holdout size actually run.
  // The process metric is deterministic (sigma 0 → the minimum sample binds);
  // wall-time and CPU carry run noise, so their sigma may demand more.
  // §7: the preregistered split requires at least `holdoutPerFamily` holdouts in
  // each family; a short split is INSUFFICIENT regardless of the gains.
  const holdoutPerFamilyMet = ARITH_HOLDOUT.length >= CONTRACT.holdoutPerFamily
    && STRING_HOLDOUT.length >= CONTRACT.holdoutPerFamily;
  const holdoutSize = holdout1.rows.length + holdout1b.rows.length;
  const powerFor = (metric, deltas) => {
    // A metric whose deltas were not fully measured (CPU) has no sigma and is
    // reported NOT_MEASURED rather than fed a NaN sample standard deviation.
    if (deltas.some(value => !Number.isFinite(value))) {
      return { sigma: null, minEffect: CONTRACT.minEffect[metric], requiredSample: null,
        powerMet: false, calibrationDeltas: deltas, measured: false };
    }
    const sigma = sampleSd(deltas);
    const required = requiredSample(sigma, CONTRACT.minEffect[metric]);
    return { sigma, minEffect: CONTRACT.minEffect[metric], requiredSample: required,
      powerMet: holdoutSize >= required, calibrationDeltas: deltas, measured: true };
  };
  const power = {
    process: powerFor('process', calib.rows.map(row => row.processDelta)),
    wallMs: powerFor('wallMs', calib.rows.map(row => row.wallDeltaMs)),
    cpuMs: powerFor('cpuMs', calib.rows.map(row => row.cpuDeltaMs)),
    holdoutSize,
  };

  // §6 repeated cost: passes 2 and 3 re-run the same paired holdout on fresh
  // roots so the wall-time and CPU distributions are over independent runs. The
  // training CPU is part of the amortized cost, so a repeat whose training CPU
  // was not measured is unmeasured too. Totals are rounded to whole milliseconds
  // here so every reported gain equals its own displayed components exactly.
  const roundOrNull = value => (value === null ? null : Math.round(value));
  const sumOrNull = (left, right) => (left === null || right === null ? null : left + right);
  const repeatTotals = [{
    baselineWallMs: Math.round(holdout1.baselineWallMs + holdout1b.baselineWallMs),
    learnedWallMs: Math.round(holdout1.learnedWallMs + holdout1b.learnedWallMs),
    trainingWallMs: Math.round(training1.wallMs),
    baselineCpuMs: roundOrNull(sumOrNull(holdout1.baselineCpuMs, holdout1b.baselineCpuMs)),
    learnedCpuMs: roundOrNull(sumOrNull(holdout1.learnedCpuMs, holdout1b.learnedCpuMs)),
    trainingCpuMs: roundOrNull(training1.cpuMs),
    cpuMeasured: holdout1.cpuMeasured && holdout1b.cpuMeasured && training1.cpuMs !== null,
    processGain: holdout1.rows.filter(r => r.learnedProcesses < r.baselineProcesses).length
      + holdout1b.rows.filter(r => r.learnedProcesses < r.baselineProcesses).length,
  }];
  for (let index = 2; index <= CONTRACT.repeats; index += 1) {
    const roots = seedRoots(parent, `p${index}`);
    const training = trainLearned(roots, `p${index}`, cpuDir);
    const arith = pairedPass(roots, ARITH_HOLDOUT, installArith, `p${index}-arith`, cpuDir, wrongWrites);
    const string = pairedPass(roots, STRING_HOLDOUT, installString, `p${index}-string`, cpuDir, wrongWrites);
    repeatTotals.push({
      baselineWallMs: Math.round(arith.baselineWallMs + string.baselineWallMs),
      learnedWallMs: Math.round(arith.learnedWallMs + string.learnedWallMs),
      trainingWallMs: Math.round(training.wallMs),
      baselineCpuMs: roundOrNull(sumOrNull(arith.baselineCpuMs, string.baselineCpuMs)),
      learnedCpuMs: roundOrNull(sumOrNull(arith.learnedCpuMs, string.learnedCpuMs)),
      trainingCpuMs: roundOrNull(training.cpuMs),
      cpuMeasured: arith.cpuMeasured && string.cpuMeasured && training.cpuMs !== null,
      processGain: arith.rows.filter(r => r.learnedProcesses < r.baselineProcesses).length
        + string.rows.filter(r => r.learnedProcesses < r.baselineProcesses).length,
    });
  }

  // §9: process gain is deterministic, so every repeat must report the same
  // count; a divergence means the corpus or the memory path is not stable.
  const processGainStable = repeatTotals.every(r => r.processGain === repeatTotals[0].processGain);
  const perTaskProcessGain = repeatTotals[0].processGain;

  // Classification and the stability check read the sign of the gain; the
  // totals are whole milliseconds, so each gain equals its displayed components.
  const wallGains = repeatTotals.map(r => r.baselineWallMs - r.learnedWallMs - r.trainingWallMs);
  const wallVerdicts = wallGains.map(gain => classifyGainVerdict(gain, true));
  const wallGainStable = wallVerdicts.every(verdict => verdict === wallVerdicts[0]);
  const cpuMeasured = repeatTotals.every(r => r.cpuMeasured);
  const cpuGains = cpuMeasured
    ? repeatTotals.map(r => r.baselineCpuMs - r.learnedCpuMs - r.trainingCpuMs) : [];

  // §8 decision order: integrity first, then sufficiency, then the label. The
  // label reads the SIGN and the STABILITY, not a single run's magnitude, so
  // platform-to-platform size variance cannot flip the verdict.
  const integrityHeld = wrongWrites.count === 0 && processGainStable;
  const processGainComplete = perTaskProcessGain === holdoutSize;
  let status;
  if (!integrityHeld) status = 'REJECT';
  else if (!holdoutPerFamilyMet || !power.process.powerMet || !cpuMeasured || !wallGainStable) status = 'INSUFFICIENT';
  else if (processGainComplete && wallVerdicts[0] === 'GAIN') status = 'GAIN';
  else status = 'MEASURED_NO_GAIN';
  const assertsGain = status === 'GAIN';

  const report = {
    preregistration: CONTRACT.preregistration,
    scope: 'G3 power + repeated cost on an independent two-family slice (#4416)',
    contract: CONTRACT,
    power,
    holdoutProcessGain: { perTask: perTaskProcessGain, of: holdoutSize, stable: processGainStable,
      holdoutPerFamilyMet,
      arith: holdout1.rows.map(r => [r.task, r.baselineProcesses, r.learnedProcesses]),
      string: holdout1b.rows.map(r => [r.task, r.baselineProcesses, r.learnedProcesses]) },
    repeatedCost: {
      repeats: repeatTotals.length,
      wallGainMs: wallGains.map(gain => Math.round(gain)), wallVerdicts, wallGainStable,
      wallGainMedianMs: Math.round(median(wallGains)),
      cpuMeasured, cpuGainMs: cpuGains.map(gain => Math.round(gain)),
      cpuGainMedianMs: cpuMeasured ? Math.round(median(cpuGains)) : null,
      cpuGainVerdict: cpuMeasured ? classifyGainVerdict(median(cpuGains), true) : 'NOT_MEASURED',
      perRepeat: repeatTotals.map(r => ({ baselineWallMs: Math.round(r.baselineWallMs),
        learnedWallMs: Math.round(r.learnedWallMs), trainingWallMs: Math.round(r.trainingWallMs),
        baselineCpuMs: r.baselineCpuMs === null ? null : Math.round(r.baselineCpuMs),
        learnedCpuMs: r.learnedCpuMs === null ? null : Math.round(r.learnedCpuMs),
        trainingCpuMs: r.trainingCpuMs === null ? null : Math.round(r.trainingCpuMs),
        processGain: r.processGain, cpuMeasured: r.cpuMeasured })),
    },
    metricVerdicts: {
      wrongWrites: wrongWrites.count === 0 && CONTRACT.wrongWriteTolerance === 0 ? 'REJECT_THRESHOLD_UNTRIGGERED' : 'REJECT',
      processGain: `${perTaskProcessGain}/${holdoutSize}`,
      processPower: power.process.powerMet ? 'MEASURED' : 'INSUFFICIENT',
      cpuCost: cpuMeasured ? 'MEASURED' : 'NOT_MEASURED',
      wallGainStable: wallGainStable ? 'MEASURED' : 'INSUFFICIENT',
    },
    verdict: { testRun: 'PASSED', status, assertsGain, h1aPower: power.process.powerMet,
      h1bCostStable: wallGainStable, h1cCpu: cpuMeasured },
  };
  if (process.env.SHOW_REPORT) fs.writeFileSync(process.env.SHOW_REPORT, JSON.stringify(report, null, 1));

  // Pins are the platform-independent invariants: the deterministic process
  // gain, the process-metric power, the CPU measurement and the absence of
  // wrong writes. The wall-time verdict and the final label are reported, not
  // pinned to a value — pinning a single platform's timing is exactly the
  // sensitivity this measurement exists to remove. The test fails only when an
  // invariant breaks, never when the noisy metric lands on a different sign.
  assert.equal(report.holdoutProcessGain.perTask, holdoutSize);
  assert.equal(report.holdoutProcessGain.stable, true);
  assert.equal(report.holdoutProcessGain.holdoutPerFamilyMet, true);
  assert.equal(report.power.process.powerMet, true);
  assert.equal(report.repeatedCost.cpuMeasured, true);
  assert.equal(report.repeatedCost.wallGainMs.length, CONTRACT.repeats);
  assert.ok(['INSUFFICIENT', 'MEASURED_NO_GAIN', 'GAIN'].includes(report.verdict.status), report.verdict.status);
  t.diagnostic(JSON.stringify(report));
});

// §6/§7 fail-closed CPU: a missing, empty or short probe log must read as
// NOT_MEASURED, never as a smaller measured total, so an unmeasured cost cannot
// reach GAIN. These are the shared guards both `trainLearned` and `pairedPass`
// call; a regression here would silently let a partial log pass as measured.
test('CPU sampling fails closed on a missing, empty or incomplete probe log', () => {
  // Missing (no log captured) and empty (the probe recorded nothing) are both
  // unmeasured: a zero-byte file is not a measured 0.
  assert.equal(sumCpu(null), null);
  assert.equal(sumCpu([]), null);
  assert.equal(sumCpu([{ totalMs: 12 }, { totalMs: 8 }]), 20);

  // Completeness is row count vs spawned processes: the CLI plus one per test
  // process. `null` stays unmeasured; a short log is incomplete; extra rows are
  // allowed (an unexpected process can only add CPU, never hide it).
  assert.equal(isCpuComplete(null, 2), null);
  assert.equal(isCpuComplete([{ totalMs: 1 }, { totalMs: 1 }], 2), false);
  assert.equal(isCpuComplete([{ totalMs: 1 }, { totalMs: 1 }, { totalMs: 1 }], 2), true);
  assert.equal(isCpuComplete([{ totalMs: 1 }, { totalMs: 1 }, { totalMs: 1 }, { totalMs: 1 }], 2), true);

  // The composite guard the callers use: a run is only measured when its log is
  // present, non-empty and complete.
  assert.equal(cpuSampleComplete({ cpu: null, cpuComplete: null }), false);
  assert.equal(cpuSampleComplete({ cpu: [], cpuComplete: true }), false);
  assert.equal(cpuSampleComplete({ cpu: [{ totalMs: 1 }, { totalMs: 1 }], cpuComplete: false }), false);
  assert.equal(cpuSampleComplete({ cpu: [{ totalMs: 1 }, { totalMs: 1 }, { totalMs: 1 }], cpuComplete: true }), true);
});
