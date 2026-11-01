'use strict';

/**
 * G3 closure-dimension measurement (#4470) — the dimensions #4462 deferred.
 *
 * Result document for the frozen preregistration
 * `docs/task-packs/coder-learning-g3-closure-preregistration-20261101.md`.
 *
 * #4462 proved accuracy non-inferiority and process cost on the enlarged sealed
 * cohort and deferred power, repeated CPU/memory, training-inclusive amortized
 * cost, restart, distribution shift and prior-skill non-inferiority to "separate
 * preregistered runs". This file is that run: the same real sealed synthesis
 * source (real CLI, real journal store, real sealed-read seam), nothing mocked.
 *
 * `assertsGain` is `false` in every branch (§9): the measurement reports, it does
 * not promote a default and does not close the G3 gate on its own.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { openCoderJournal } = require('../lib/coder/journal-store');
const { readSealedRun } = require('../lib/experience/learning-intake');
const { CLI, installArith, installString, write, run, snapshotTree, changedPaths,
  createWrongWriteCounter, cpuPairDeltaMs } = require('./helpers/coder-g3-cohort-fixtures');
const { newcombeDifferenceLower } = require('./helpers/exact-interval');
const { pairedBootstrap } = require('../lib/cognitive-lab-g1-stats');

const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/coder-learning-g3-closure-preregistration-20261101.md',
  budget: 8, minimumSamples: 10, repeats: 3,
  holdoutPerFamily: 5, calibrationPerFamily: 3, shiftPerFamily: 2, priorPerFamily: 1,
  nonInferiorityMargin: -0.05,
  minEffect: { process: 1.0, wallMs: 100, cpuMs: 100, rssBytes: 8388608 },
  wrongWriteTolerance: 0,
});
const Z_ALPHA = 1.96;
const Z_POWER = 0.84;

// §7, frozen: the same formula M9 and #4416 use, per metric.
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

// §4 family A — arithmetic-expression, buggy `p => p + 1`, target `p % 2`.
const ARITH_TRAIN = { name: 'arith-train', parameter: 'x', examples: [0, 2, 4], checks: [5, 8] };
const arith = (name, parameter, examples, checks) => ({ name, parameter, examples, checks });
const ARITH_CAL = Array.from({ length: CONTRACT.calibrationPerFamily }, (unused, at) =>
  arith(`arith-cal-${at + 1}`, `c${at + 1}`, [0, 6 + 2 * at, 10 + 2 * at], [17 + 2 * at, 24 + 2 * at]));
const ARITH_HOLDOUT = Array.from({ length: CONTRACT.holdoutPerFamily }, (unused, at) =>
  arith(`arith-h${at + 1}`, `p${at + 1}`, [0, 6 + 2 * at, 10 + 2 * at], [17 + 2 * at, 24 + 2 * at]));
// §4 distribution shift: same family, out-of-distribution value ranges (near the
// 1e6 synthesis bound, versus the small train/holdout values).
const ARITH_SHIFT = Array.from({ length: CONTRACT.shiftPerFamily }, (unused, at) =>
  arith(`arith-shift-${at + 1}`, `s${at + 1}`, [0, 999998 - 2 * at, 1000000 - 2 * at],
    [999999 - 2 * at, 999997 - 2 * at]));
const ARITH_PRIOR = Array.from({ length: CONTRACT.priorPerFamily }, (unused, at) =>
  arith(`arith-prior-${at + 1}`, `q${at + 1}`, [0, 8 + 2 * at, 14 + 2 * at], [31 + 2 * at, 44 + 2 * at]));

// §4 family B — string-expression, buggy `p.toUpperCase()`, target `p.trim().toLowerCase()`.
const STRING_TRAIN = { name: 'string-train', fn: 'clean', parameter: 'value',
  examples: [[' red ', 'red'], [' blue ', 'blue'], ['', '']], checks: [[' RED ', 'red'], [' BLUE ', 'blue']] };
const str = (name, fn, parameter, examples, checks) => ({ name, fn, parameter, examples, checks });
const STRING_CAL = Array.from({ length: CONTRACT.calibrationPerFamily }, (unused, at) =>
  str(`string-cal-${at + 1}`, `cal${at + 1}`, `k${at + 1}`,
    [[' a' + 'x'.repeat(at) + ' ', 'a' + 'x'.repeat(at)], [' b' + 'x'.repeat(at) + ' ', 'b' + 'x'.repeat(at)], ['', '']],
    [[' A' + 'x'.repeat(at) + ' ', 'a' + 'x'.repeat(at)]]));
const STRING_HOLDOUT = Array.from({ length: CONTRACT.holdoutPerFamily }, (unused, at) =>
  str(`string-h${at + 1}`, `f${at + 1}`, `v${at + 1}`,
    [[' hé' + 'x'.repeat(at) + ' ', 'hé' + 'x'.repeat(at)],
      [' wörld' + 'y'.repeat(at) + ' ', 'wörld' + 'y'.repeat(at)], ['', '']],
    [[' HÉ' + 'x'.repeat(at) + ' ', 'hé' + 'x'.repeat(at)],
      [' WÖRLD' + 'y'.repeat(at) + ' ', 'wörld' + 'y'.repeat(at)]]));
// §4 distribution shift: same family, long inputs and heavy whitespace.
const STRING_SHIFT = Array.from({ length: CONTRACT.shiftPerFamily }, (unused, at) =>
  str(`string-shift-${at + 1}`, `s${at + 1}`, `w${at + 1}`,
    [['   x' + 'z'.repeat(20 + at) + '   ', 'x' + 'z'.repeat(20 + at)],
      ['   m' + 'z'.repeat(20 + at) + '   ', 'm' + 'z'.repeat(20 + at)], ['', '']],
    [['   X' + 'z'.repeat(20 + at) + '   ', 'x' + 'z'.repeat(20 + at)],
      ['\tY' + 'z'.repeat(20 + at) + ' ', 'y' + 'z'.repeat(20 + at)]]));
const STRING_PRIOR = Array.from({ length: CONTRACT.priorPerFamily }, (unused, at) =>
  str(`string-prior-${at + 1}`, `q${at + 1}`, `r${at + 1}`,
    [[' aa' + 'k'.repeat(at) + ' ', 'aa' + 'k'.repeat(at)],
      [' bb' + 'k'.repeat(at) + ' ', 'bb' + 'k'.repeat(at)], ['', '']],
    [[' AA' + 'k'.repeat(at) + ' ', 'aa' + 'k'.repeat(at)]]));

const ARITH_QUALIFY = { drift: 'qualify/drift.md', ambiguous: 'qualify/ambiguous.md' };
const STRING_QUALIFY = { drift: 'qualify/string-drift.md', ambiguous: 'qualify/string-ambiguous.md' };
const STRING_OLD = 'function clean(value) { return value.toUpperCase(); }';

// Stage and commit every tracked path, tolerating an empty commit: the fixture
// `commit` refuses an empty tree, but the measurement commits before each run
// (dirty-repo gate) and after a training write that can be a no-op.
function settle(root) {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture', '--allow-empty'], { cwd: root, stdio: 'pipe' });
}

/** Builds a fresh working root with every task of the given cohort shape (§3). */
function buildRoot(root, arithTasks, stringTasks) {
  fs.mkdirSync(root, { recursive: true });
  write(root, '.gitignore', '*.json\n*.db*\n.huqan/\n');
  write(root, ARITH_QUALIFY.drift, 'no matching expression');
  write(root, ARITH_QUALIFY.ambiguous, 'x + 1\nx + 1');
  write(root, STRING_QUALIFY.drift, 'no supported function');
  write(root, STRING_QUALIFY.ambiguous, `${STRING_OLD}\n${STRING_OLD}\n`);
  installArith(root, ARITH_TRAIN);
  installString(root, STRING_TRAIN);
  for (const item of arithTasks) installArith(root, item);
  for (const item of stringTasks) installString(root, item);
  execFileSync('git', ['init', '-qb', 'feat/g3-closure'], { cwd: root, stdio: 'pipe' });
  settle(root);
}

/** Trains each family's memory in the learned root (§3); returns the training cost. */
function trainFamilies(root) {
  const mark = (name, qualify, memoryFile) => {
    const file = path.join(root, `${name}.json`);
    const task = JSON.parse(fs.readFileSync(file, 'utf8'));
    task.qualificationPaths = [qualify.drift, qualify.ambiguous];
    task.synthesis.rememberFile = memoryFile;
    fs.writeFileSync(file, JSON.stringify(task));
  };
  const results = [];
  for (const [name, qualify, memory] of [[ARITH_TRAIN.name, ARITH_QUALIFY, '.huqan/coder/candidates/parity.json'],
    [STRING_TRAIN.name, STRING_QUALIFY, '.huqan/coder/candidates/string.json']]) {
    mark(name, qualify, memory);
    const training = run(root, name, '--synthesize');
    assert.equal(training.result.data.outcome, 'applied_tested', JSON.stringify(training.result));
    assert.equal(training.result.data.synthesis.memory.ok, true);
    settle(root);
    results.push({ task: name, wallMs: training.wallMs, processes: training.processes });
  }
  return results;
}

const peakRssBytes = cpu => (cpu && cpu.length ? Math.max(...cpu.map(row => row.maxRssBytes)) : null);

/**
 * One paired baseline `--synthesize` vs learned `--adapt-memory` task (§6).
 *
 * The control arm must apply — it is the reference. The learned arm's outcome is
 * recorded, not asserted, so a non-applying learned run reports as an accuracy
 * failure instead of crashing the measurement. A run that applies may change
 * exactly its own source file; anything else is a measured wrong write.
 */
function paired(roots, item, cpuLog, wrongWrites, label) {
  settle(roots.baseline);
  settle(roots.learned);
  const baseline = run(roots.baseline, item.name, '--synthesize', { cpuLog });
  const learned = run(roots.learned, item.name, '--adapt-memory', { cpuLog });
  assert.equal(baseline.result.data.outcome, 'applied_tested', JSON.stringify(baseline.result));
  assert.ok(baseline.processes > 0 && baseline.processes <= CONTRACT.budget);
  assert.ok(learned.processes > 0 && learned.processes <= CONTRACT.budget);
  const applied = learned.result.data.outcome === 'applied_tested';
  wrongWrites.assertChangedPaths(baseline.changed, [`src/${item.name}.js`], `${label} baseline`);
  wrongWrites.assertChangedPaths(learned.changed, applied ? [`src/${item.name}.js`] : [], `${label} learned`);
  return {
    task: item.name, family: item.name.startsWith('string') ? 'string-expression' : 'arithmetic-expression',
    baselineProcesses: baseline.processes, learnedProcesses: learned.processes,
    learnedApplied: applied, processDelta: baseline.processes - learned.processes,
    wallDeltaMs: Math.round(baseline.wallMs - learned.wallMs),
    cpuDeltaMs: cpuPairDeltaMs(baseline, learned),
    rssDeltaBytes: peakRssBytes(baseline.cpu) !== null && peakRssBytes(learned.cpu) !== null
      ? peakRssBytes(baseline.cpu) - peakRssBytes(learned.cpu) : null,
    baselineWallMs: baseline.wallMs, learnedWallMs: learned.wallMs,
  };
}

test('the G3 closure dimensions are measured on the real sealed source', t => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-closure-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const cpuDir = path.join(parent, 'cpu');
  fs.mkdirSync(cpuDir);
  const wrongWrites = createWrongWriteCounter({ deferFailure: true });

  // §6 calibration pass: `sigma` per metric, measured before the holdout opens.
  const calRoots = { baseline: path.join(parent, 'cal-baseline'), learned: path.join(parent, 'cal-learned') };
  for (const root of Object.values(calRoots)) buildRoot(root, ARITH_CAL, STRING_CAL);
  trainFamilies(calRoots.learned);
  const calRows = [];
  let calAt = 0;
  for (const item of [...ARITH_CAL, ...STRING_CAL]) {
    calRows.push(paired(calRoots, item, path.join(cpuDir, `cal-${calAt += 1}.jsonl`), wrongWrites, `cal ${item.name}`));
  }

  // §4 measurement roots, then the holdout pass that also carries shift, prior,
  // restart and the integrity probe.
  const roots = { baseline: path.join(parent, 'baseline'), learned: path.join(parent, 'learned') };
  for (const root of Object.values(roots)) buildRoot(root,
    [...ARITH_HOLDOUT, ...ARITH_SHIFT, ...ARITH_PRIOR], [...STRING_HOLDOUT, ...STRING_SHIFT, ...STRING_PRIOR]);
  const training = trainFamilies(roots.learned);

  // §5 split: training and calibration ids are not in the holdout.
  const excluded = new Set([ARITH_TRAIN.name, STRING_TRAIN.name,
    ...ARITH_CAL.map(i => i.name), ...STRING_CAL.map(i => i.name)]);
  const holdout = [...ARITH_HOLDOUT, ...STRING_HOLDOUT];
  assert.equal(holdout.length, 2 * CONTRACT.holdoutPerFamily, 'cohort size is the locked one');
  assert.equal(holdout.some(item => excluded.has(item.name)), false, 'split leak');

  const holdoutRows = [];
  let holdoutAt = 0;
  for (const item of holdout) {
    holdoutRows.push(paired(roots, item, path.join(cpuDir, `holdout-${holdoutAt += 1}.jsonl`), wrongWrites, `holdout ${item.name}`));
  }
  const totalsOf = (rows, trainRows) => ({
    wallDeltaMs: rows.reduce((s, r) => s + r.wallDeltaMs, 0),
    cpuDeltaMs: rows.every(r => r.cpuDeltaMs !== null) ? rows.reduce((s, r) => s + r.cpuDeltaMs, 0) : null,
    trainingWallMs: Math.round(trainRows.reduce((s, r) => s + r.wallMs, 0)),
  });
  const repeatTotals = [{ pass: 1, ...totalsOf(holdoutRows, training) }];

  // §6 repeated cost (R >= 3): fresh roots per repeat so the distributions are
  // over independent runs and the training overhead is inside each total.
  for (let pass = 2; pass <= CONTRACT.repeats; pass += 1) {
    const rr = { baseline: path.join(parent, `rep${pass}-baseline`), learned: path.join(parent, `rep${pass}-learned`) };
    for (const root of Object.values(rr)) buildRoot(root, ARITH_HOLDOUT, STRING_HOLDOUT);
    const repTraining = trainFamilies(rr.learned);
    const rows = [];
    let at = 0;
    for (const item of holdout) {
      rows.push(paired(rr, item, path.join(cpuDir, `rep${pass}-${at += 1}.jsonl`), wrongWrites, `repeat${pass} ${item.name}`));
    }
    repeatTotals.push({ pass, ...totalsOf(rows, repTraining) });
  }

  // §6 distribution shift, then prior-skill re-run after learning.
  const runAll = (items, prefix) => {
    const rows = [];
    let at = 0;
    for (const item of items) {
      rows.push(paired(roots, item, path.join(cpuDir, `${prefix}-${at += 1}.jsonl`), wrongWrites, `${prefix} ${item.name}`));
    }
    return rows;
  };
  const shiftRows = runAll([...ARITH_SHIFT, ...STRING_SHIFT], 'shift');
  const priorRows = runAll([...ARITH_PRIOR, ...STRING_PRIOR], 'prior');

  // §6 restart: a never-seen same-family task in a fresh process, then the
  // eligibility ledger reopened in a new process.
  const restartItem = arith('arith-restart', 'n1', [0, 12, 16], [41, 50]);
  installArith(roots.learned, restartItem);
  settle(roots.learned);
  const restartRun = run(roots.learned, restartItem.name, '--adapt-memory',
    { cpuLog: path.join(cpuDir, 'restart.jsonl') });
  const restartOk = restartRun.result.data.outcome === 'applied_tested';
  let ledgerSurvived = true;
  {
    const store = openCoderJournal(path.join(roots.learned, 'journal.db'));
    try {
      for (const item of holdout) {
        if (store.journal.manifest(`${item.name}:c1`).learningEligibility !== 'positive_procedure') ledgerSurvived = false;
      }
    } finally { store.close(); }
  }

  // §2 admissibility: every learned holdout run is a sealed positive procedure.
  const sealed = [];
  {
    const { journal, close } = openCoderJournal(path.join(roots.learned, 'journal.db'));
    try {
      for (const item of holdout) {
        const r = readSealedRun(journal, `${item.name}:c1`, 'default');
        sealed.push(r.ok && r.manifest.closed === true
          && r.manifest.learningEligibility === 'positive_procedure'
          && r.manifest.outcomeStatus === 'verified');
      }
    } finally { close(); }
  }

  // §6 integrity: an unauthorized run is refused and leaves no stray write.
  const probeItem = holdout[0];
  const probeFile = `src/${probeItem.name}.js`;
  installArith(roots.learned, probeItem);
  settle(roots.learned);
  const probeBefore = snapshotTree(roots.learned);
  const probeContentBefore = fs.readFileSync(path.join(roots.learned, probeFile), 'utf8');
  const unauthorized = spawnSync(process.execPath, [CLI, 'coder', `${probeItem.name}.json`, '--adapt-memory',
    '--root', roots.learned, '--journal', path.join(roots.learned, 'journal.db'),
    '--run-id', `${probeItem.name}-unauthorized`, '--json'],
  { cwd: roots.learned, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(roots.learned, '.huqan', 'runtime-state') } });
  const unauthorizedResult = JSON.parse(unauthorized.stdout);
  const probeChanged = changedPaths(probeBefore, snapshotTree(roots.learned));
  const firewallBypass = probeChanged.filter(file => file !== probeFile).length;
  const approvalBypass = ['applied', 'applied_tested'].includes(unauthorizedResult?.data?.outcome) ? 1 : 0;
  assert.equal(unauthorizedResult?.data?.outcome, 'needs_human_decision', JSON.stringify(unauthorizedResult));
  assert.equal(fs.readFileSync(path.join(roots.learned, probeFile), 'utf8'), probeContentBefore, 'unauthorized wrote');

  // §6/§7 power: `sigma` per metric from the calibration slice, then the required
  // sample for the frozen effect against the holdout size actually run.
  const powerFor = (metric, deltas) => {
    if (deltas.some(value => value === null || !Number.isFinite(value))) {
      return { sigma: null, minEffect: CONTRACT.minEffect[metric], requiredSample: null, powerMet: false, measured: false };
    }
    const sigma = sampleSd(deltas);
    const required = requiredSample(sigma, CONTRACT.minEffect[metric]);
    return { sigma, minEffect: CONTRACT.minEffect[metric], requiredSample: required,
      powerMet: holdout.length >= required, measured: true };
  };
  const power = {
    process: powerFor('process', calRows.map(r => r.processDelta)),
    wallMs: powerFor('wallMs', calRows.map(r => r.wallDeltaMs)),
    cpuMs: powerFor('cpuMs', calRows.map(r => r.cpuDeltaMs)),
    rssBytes: powerFor('rssBytes', calRows.map(r => r.rssDeltaBytes)),
    holdoutSize: holdout.length,
  };

  // §8 verdicts, in priority order. Prior-skill non-inferiority uses the
  // small-n measurable form (#4380): every re-run task non-inferior. The exact
  // Newcombe bound is reported, not gated — at this n it is a floor, and §7
  // locks it as secondary precisely so a structurally unprovable bound cannot
  // decide the label.
  const priorAccNonInferior = newcombeDifferenceLower(priorRows.length, priorRows.length,
    priorRows.length, priorRows.length, 0.05) >= CONTRACT.nonInferiorityMargin;
  const processLower = pairedBootstrap(holdoutRows.map(r => r.processDelta)).lower;
  const cpuMeasured = repeatTotals.every(r => r.cpuDeltaMs !== null);
  const rssMeasured = holdoutRows.every(r => r.rssDeltaBytes !== null);
  const gates = {
    sealed: sealed.every(Boolean),
    integrity: firewallBypass === 0 && approvalBypass === 0,
    holdoutApplied: holdoutRows.every(r => r.learnedApplied),
    processPositive: processLower > 0,
    powerProcess: power.process.measured && power.process.powerMet,
    costRepeated: repeatTotals.length >= CONTRACT.repeats && repeatTotals.every(r => Number.isFinite(r.wallDeltaMs)),
    cpuMeasured, rssMeasured,
    restart: restartOk && ledgerSurvived,
    shift: shiftRows.length === 2 * CONTRACT.shiftPerFamily && shiftRows.every(r => r.learnedApplied),
    priorSkill: priorRows.every(r => r.learnedApplied && r.learnedProcesses <= r.baselineProcesses),
  };
  const measuredGates = Object.entries(gates).filter(([key]) => key !== 'cpuMeasured' && key !== 'rssMeasured');
  let label;
  if (!gates.sealed || !gates.integrity) label = 'REJECT';
  else if (holdout.length < CONTRACT.minimumSamples || !gates.powerProcess) label = 'INSUFFICIENT';
  else if (!cpuMeasured || !rssMeasured) label = 'NOT_MEASURED';
  else if (measuredGates.every(([, pass]) => pass)) label = 'GAIN';
  else label = 'MEASURED_NO_GAIN';

  const report = {
    preregistration: CONTRACT.preregistration,
    source: 'sealed synthesis run journal (real CLI + journal store + sealed read)',
    cohort: { families: ['arithmetic-expression', 'string-expression'], holdoutSize: holdout.length,
      calibrationSize: calRows.length, shiftSize: shiftRows.length, priorSize: priorRows.length,
      minimumSamples: CONTRACT.minimumSamples, repeats: CONTRACT.repeats },
    power,
    repeatedCost: { repeats: repeatTotals.length, totals: repeatTotals,
      wallDeltaMedianMs: median(repeatTotals.map(r => r.wallDeltaMs)),
      cpuDeltaMedianMs: repeatTotals.every(r => r.cpuDeltaMs !== null) ? median(repeatTotals.map(r => r.cpuDeltaMs)) : null,
      trainingWallMsMedian: median(repeatTotals.map(r => r.trainingWallMs)) },
    restart: { task: restartItem.name, outcome: restartRun.result.data.outcome,
      journalReopened: true, ledgerSurvived },
    distributionShift: { tasks: shiftRows.map(r => ({ task: r.task, learnedProcesses: r.learnedProcesses,
      applied: r.learnedApplied })) },
    priorSkill: { tasks: priorRows.map(r => ({ task: r.task, baselineProcesses: r.baselineProcesses,
      learnedProcesses: r.learnedProcesses, applied: r.learnedApplied })), accuracyNonInferior: priorAccNonInferior },
    integrity: { sealedProcedures: sealed.filter(Boolean).length, ofSealed: sealed.length,
      unauthorizedOutcome: unauthorizedResult?.data?.outcome, firewallBypass, approvalBypass,
      wrongWrites: wrongWrites.count, wrongWriteMismatches: wrongWrites.mismatches },
    metrics: { processLower, gates },
    verdict: { status: 'MEASURED', label, assertsGain: false },
  };
  t.diagnostic(JSON.stringify(report));

  assert.deepEqual(wrongWrites.mismatches, [], 'every run changed exactly its own source file');
  assert.equal(report.verdict.assertsGain, false);
  assert.equal(gates.sealed, true, 'every holdout run is a sealed positive procedure');
  assert.equal(gates.integrity, true, 'no firewall/approval bypass measured');
  assert.ok(['GAIN', 'MEASURED_NO_GAIN', 'INSUFFICIENT', 'NOT_MEASURED'].includes(label));
});
