'use strict';

/**
 * G3 break-even horizon and prior-skill retention (#4505) — result document for
 * the frozen preregistration
 * `docs/task-packs/coder-learning-g3-breakeven-retention-preregistration-20261101.md`.
 *
 * #4470 measured the amortized cost at one cohort size (10 holdouts) and found
 * it negative; it did not answer "at how many repeated uses is the training
 * overhead repaid". #4470's prior-skill dimension also had to admit it measured
 * a *fresh same-family transfer*, not retention of a distinct earlier skill,
 * because the learned memory holds one candidate per family.
 *
 * This file closes both gaps on the same real sealed source: the real CLI, the
 * real journal store and the real sealed-read seam. Nothing is mocked. Two
 * distinct-family skills are learned in sequence (A then B); fresh tasks from
 * BOTH families are then dispatched, so family A is a *previously learned*
 * skill whose retention is measured after B was learned. The break-even horizon
 * `n*` is the number of repeated uses at which the training overhead is repaid.
 *
 * `assertsGain` is `false` in every branch (§9): the measurement reports, it
 * does not promote a default.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// #4505: the measurement spawns ~127 real `cli.js coder` children, and each one
// runs its own `node --test` workers. Under `c8` every child inherits
// `NODE_V8_COVERAGE`, so the run writes hundreds of coverage files that c8 then
// merges; on the 4 GB heap that merge OOMs even though every test passed first
// (#4470, run 41326941162). The children's coverage is redundant -- the same
// `lib/cli-coder.js` / coder paths are covered by cli.test.js and the coder
// suites -- so this file drops the variable for its children, the same trade
// `test/g3-closure-dimensions.test.js` and `test/durable-mutation-journal.test.js`
// make (#3342). The variable is read by the child at spawn, so deleting it here
// does not stop this file's own worker from writing its coverage.
delete process.env.NODE_V8_COVERAGE;

const { openCoderJournal } = require('../lib/coder/journal-store');
const { readSealedRun } = require('../lib/experience/learning-intake');
const { CLI, installArith, installString, write, commit, run,
  createWrongWriteCounter, sumCpu, cpuSampleComplete } =
  require('./helpers/coder-g3-cohort-fixtures');
const { newcombeDifferenceLower } = require('./helpers/exact-interval');
const { pairedBootstrap } = require('../lib/cognitive-lab-g1-stats');

// §7 thresholds, frozen in the preregistration before this eval ran.
const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/coder-learning-g3-breakeven-retention-preregistration-20261101.md',
  budget: 8,
  retentionPerFamily: 30,
  requiredSamplesForMargin: 59,
  breakEvenHorizonMax: 32,
  nonInferiorityMargin: -0.05,
  trainingRepeats: 3,
  bootstrap: Object.freeze({ reps: 2000, seed: 4505 }),
  wrongWriteTolerance: 0,
});

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Per-process peaks, summed because the processes run sequentially; `null` when
// the CPU sample was incomplete, so an unmeasured sample never reads as 0 (the
// same fail-closed rule as `sumCpu`).
function sumRssKb(cpu) {
  return cpu && cpu.length ? cpu.reduce((total, row) => total + (row.maxRssBytes || 0), 0) / 1024 : null;
}

// §4 corpus — families and task identities independent of the #4380/#4416/#4449/
// #4470 cohorts (neither reused nor tuned against). Family A is
// arithmetic-expression (buggy `x => x + 1`, target `x % 2`); family B is
// string-expression (buggy `p.toUpperCase()`, target `p.trim().toLowerCase()`).
const ARITH_TRAIN = { name: 'be-arith-train', parameter: 'x', examples: [0, 2, 4], checks: [5, 8] };
const STRING_TRAIN = { name: 'be-string-train', fn: 'clean', parameter: 'value',
  examples: [[' red ', 'red'], [' blue ', 'blue'], ['', '']],
  checks: [[' RED ', 'red'], [' BLUE ', 'blue']] };
// Examples stay even (many programs match them); checks mix parity, so only the
// real test separates `p % 2` from its neighbours.
const ARITH_RETENTION = Array.from({ length: CONTRACT.retentionPerFamily }, (unused, at) => ({
  name: `be-a${at + 1}`, parameter: `pa${at + 1}`,
  examples: [0, 6 + 2 * at, 10 + 2 * at], checks: [17 + 2 * at, 24 + 2 * at],
}));
const STRING_RETENTION = Array.from({ length: CONTRACT.retentionPerFamily }, (unused, at) => ({
  name: `be-s${at + 1}`, fn: `fs${at + 1}`, parameter: `vs${at + 1}`,
  examples: [[' hé' + 'x'.repeat(at) + ' ', 'hé' + 'x'.repeat(at)],
    [' wörld' + 'y'.repeat(at) + ' ', 'wörld' + 'y'.repeat(at)], ['', '']],
  checks: [[' HÉ' + 'x'.repeat(at) + ' ', 'hé' + 'x'.repeat(at)],
    [' WÖRLD' + 'y'.repeat(at) + ' ', 'wörld' + 'y'.repeat(at)]],
}));

const ARITH_QUALIFY = { drift: 'qualify/drift.md', ambiguous: 'qualify/ambiguous.md' };
const STRING_QUALIFY = { drift: 'qualify/string-drift.md', ambiguous: 'qualify/string-ambiguous.md' };
const STRING_OLD = 'function clean(value) { return value.toUpperCase(); }';

function seedRoot(root, branch) {
  fs.mkdirSync(root);
  write(root, '.gitignore', '*.json\n*.db*\n.huqan/\n');
  write(root, ARITH_QUALIFY.drift, 'no matching expression');
  write(root, ARITH_QUALIFY.ambiguous, `${ARITH_TRAIN.parameter} + 1\n${ARITH_TRAIN.parameter} + 1`);
  write(root, STRING_QUALIFY.drift, 'no supported function');
  write(root, STRING_QUALIFY.ambiguous, `${STRING_OLD}\n${STRING_OLD}\n`);
  installArith(root, ARITH_TRAIN);
  installString(root, STRING_TRAIN);
  execFileSync('git', ['init', '-qb', branch], { cwd: root, stdio: 'pipe' });
  commit(root);
}

function markTraining(root, name, qualify, memoryFile) {
  const file = path.join(root, `${name}.json`);
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  task.qualificationPaths = [qualify.drift, qualify.ambiguous];
  task.synthesis.rememberFile = memoryFile;
  fs.writeFileSync(file, JSON.stringify(task));
}

// §3: family A is learned first, family B second, so a later family-B learning
// must not disturb the family-A candidate. Returns the two-skill training cost.
function trainBoth(root, label, cpuDir) {
  markTraining(root, ARITH_TRAIN.name, ARITH_QUALIFY, '.huqan/coder/candidates/arith.json');
  const a = run(root, ARITH_TRAIN.name, '--synthesize', { cpuLog: path.join(cpuDir, `${label}-train-a.jsonl`) });
  assert.equal(a.result.data.outcome, 'applied_tested', JSON.stringify(a.result));
  commit(root);
  markTraining(root, STRING_TRAIN.name, STRING_QUALIFY, '.huqan/coder/candidates/string.json');
  const b = run(root, STRING_TRAIN.name, '--synthesize', { cpuLog: path.join(cpuDir, `${label}-train-b.jsonl`) });
  assert.equal(b.result.data.outcome, 'applied_tested', JSON.stringify(b.result));
  commit(root);
  const measured = cpuSampleComplete(a) && cpuSampleComplete(b);
  return { wallMs: a.wallMs + b.wallMs,
    cpuMs: measured ? sumCpu(a.cpu) + sumCpu(b.cpu) : null,
    rssKb: measured ? sumRssKb(a.cpu) + sumRssKb(b.cpu) : null, measured };
}

/** The sealed manifest of a run — the protocol's admissibility source (§2). */
function sealedManifest(root, runId) {
  const { journal, close } = openCoderJournal(path.join(root, 'journal.db'));
  try {
    const sealed = readSealedRun(journal, runId, 'default');
    assert.equal(sealed.ok, true, `${runId} not sealed: ${sealed.code}`);
    return { closed: sealed.manifest.closed,
      learningEligibility: sealed.manifest.learningEligibility,
      outcomeStatus: sealed.manifest.outcomeStatus, sourceHash: sealed.sourceHash };
  } finally { close(); }
}

/** Non-asserting sealed-source lookup; `null` when a run left no sealed record. */
function sealedSource(root, runId) {
  const { journal, close } = openCoderJournal(path.join(root, 'journal.db'));
  try {
    const sealed = readSealedRun(journal, `${runId}:c1`, 'default');
    return sealed.ok ? { sourceHash: sealed.sourceHash, closed: sealed.manifest.closed } : null;
  } finally { close(); }
}

test('the break-even horizon and prior-skill retention are measured on the real sealed source', t => {
  // Deferred so a wrong write still yields the REJECT report before the test fails.
  const wrongWrites = createWrongWriteCounter({ deferFailure: true });
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-breakeven-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const cpuDir = path.join(parent, 'cpu');
  fs.mkdirSync(cpuDir);

  // §7: the training cost T is re-measured on three fresh roots; the first root
  // also carries the retention cohort.
  const trainingRepeats = [];
  const roots = { baseline: path.join(parent, 'p1-baseline'), learned: path.join(parent, 'p1-learned') };
  seedRoot(roots.baseline, 'feat/be-baseline');
  seedRoot(roots.learned, 'feat/be');
  trainingRepeats.push(trainBoth(roots.learned, 'p1', cpuDir));
  for (let index = 2; index <= CONTRACT.trainingRepeats; index += 1) {
    const root = path.join(parent, `p${index}-learned`);
    seedRoot(root, 'feat/be');
    trainingRepeats.push(trainBoth(root, `p${index}`, cpuDir));
  }
  const training = {
    wallMs: trainingRepeats.map(repeat => repeat.wallMs),
    cpuMs: trainingRepeats.every(repeat => repeat.measured)
      ? trainingRepeats.map(repeat => repeat.cpuMs) : null,
    rssKb: trainingRepeats.every(repeat => repeat.measured)
      ? trainingRepeats.map(repeat => repeat.rssKb) : null,
  };

  // §5/§6: one paired pass over the retention cohort. Both arms run the same
  // task; the baseline synthesizes fresh, the learned dispatches from the memory
  // that now holds BOTH family candidates. A family-A task is the previously
  // learned skill, measured after family B was learned.
  const rows = [];
  let measured = true;
  for (const [install, items, family] of [[installArith, ARITH_RETENTION, 'arithmetic-expression'],
    [installString, STRING_RETENTION, 'string-expression']]) {
    for (const item of items) {
      const baselineFixture = install(roots.baseline, item);
      const learnedFixture = install(roots.learned, item);
      assert.equal(baselineFixture.taskHash, learnedFixture.taskHash);
      assert.equal(baselineFixture.testHash, learnedFixture.testHash);
      for (const root of Object.values(roots)) commit(root);
      const baseline = run(roots.baseline, item.name, '--synthesize',
        { cpuLog: path.join(cpuDir, `${item.name}-baseline.jsonl`) });
      const learned = run(roots.learned, item.name, '--adapt-memory',
        { cpuLog: path.join(cpuDir, `${item.name}-learned.jsonl`) });
      for (const row of [baseline, learned]) {
        assert.equal(row.result.data.outcome, 'applied_tested', JSON.stringify(row));
        assert.ok(row.processes > 0 && row.processes <= CONTRACT.budget);
      }
      assert.equal(fs.readFileSync(path.join(roots.baseline, `src/${item.name}.js`), 'utf8'),
        fs.readFileSync(path.join(roots.learned, `src/${item.name}.js`), 'utf8'));
      wrongWrites.assertChangedPaths(baseline.changed, [`src/${item.name}.js`], `${item.name} baseline`);
      wrongWrites.assertChangedPaths(learned.changed, [`src/${item.name}.js`], `${item.name} learned`);
      const pairComplete = cpuSampleComplete(baseline) && cpuSampleComplete(learned);
      if (!pairComplete) measured = false;
      rows.push({
        task: item.name, family, taskHash: baselineFixture.taskHash,
        baselineOutcome: baseline.result.data.outcome, learnedOutcome: learned.result.data.outcome,
        baselineProcesses: baseline.processes, learnedProcesses: learned.processes,
        processDelta: baseline.processes - learned.processes,
        wallSavingMs: baseline.wallMs - learned.wallMs,
        cpuSavingMs: pairComplete ? sumCpu(baseline.cpu) - sumCpu(learned.cpu) : null,
        rssSavingKb: pairComplete ? sumRssKb(baseline.cpu) - sumRssKb(learned.cpu) : null,
      });
    }
  }
  const retentionSize = rows.length;
  const metricsOf = family => {
    const subset = family ? rows.filter(row => row.family === family) : rows;
    const successes = subset.filter(row => row.learnedOutcome === 'applied_tested').length;
    const baselineSuccesses = subset.filter(row => row.baselineOutcome === 'applied_tested').length;
    return {
      tasks: subset.length, learnedSuccesses: successes, baselineSuccesses,
      processNotWorse: subset.every(row => row.learnedProcesses <= row.baselineProcesses),
      newcombeLower: newcombeDifferenceLower(successes, subset.length, baselineSuccesses, subset.length, 0.05),
    };
  };
  const pooled = metricsOf(null);
  const perFamily = {
    'arithmetic-expression': metricsOf('arithmetic-expression'),
    'string-expression': metricsOf('string-expression'),
  };
  // §7: the -0.05 margin is provable from N=59 (#4449/#4422); below it the bound
  // is a floor, so the retention dimension would be INSUFFICIENT.
  const marginProvable = retentionSize >= CONTRACT.requiredSamplesForMargin;
  const retentionNonInferior = pooled.learnedSuccesses >= pooled.baselineSuccesses && pooled.processNotWorse;
  const retentionMarginMet = pooled.newcombeLower >= CONTRACT.nonInferiorityMargin;
  const priorSkillRetained = perFamily['arithmetic-expression'].learnedSuccesses
    === perFamily['arithmetic-expression'].tasks;

  // §6 break-even: n* = ceil(T / median(s)) per metric; s <= 0 means no finite
  // horizon (the overhead is never repaid). The saving distribution is reported,
  // not just the median.
  const wallSavings = rows.map(row => row.wallSavingMs);
  const cpuSavings = measured ? rows.map(row => row.cpuSavingMs) : null;
  const rssSavings = measured ? rows.map(row => row.rssSavingKb) : null;
  const horizon = (trainingValues, savings) => {
    if (!trainingValues || !savings || savings.some(value => !Number.isFinite(value))) {
      return { trainingMedian: null, savingMedian: null, horizonTasks: null, reached: false, measured: false };
    }
    const trainingMedian = median(trainingValues);
    const savingMedian = median(savings);
    const horizonTasks = savingMedian > 0 ? Math.ceil(trainingMedian / savingMedian) : null;
    return { trainingMedian, savingMedian, horizonTasks,
      reached: horizonTasks !== null && horizonTasks <= CONTRACT.breakEvenHorizonMax, measured: true };
  };
  const breakEven = {
    wallMs: horizon(training.wallMs, wallSavings),
    cpuMs: horizon(training.cpuMs, cpuSavings),
    rssKb: horizon(training.rssKb, rssSavings),
  };
  const bootstrap = values => (values && values.every(Number.isFinite)
    ? pairedBootstrap(values, { reps: CONTRACT.bootstrap.reps, seed: CONTRACT.bootstrap.seed }) : null);
  const savingInterval = {
    wallMs: bootstrap(wallSavings), cpuMs: bootstrap(cpuSavings), rssKb: bootstrap(rssSavings),
  };
  const netAt = (savingMedian, trainingMedian) => (savingMedian === null || trainingMedian === null
    ? null : retentionSize * savingMedian - trainingMedian);
  const amortizedNet = {
    wallMs: netAt(breakEven.wallMs.savingMedian, breakEven.wallMs.trainingMedian),
    cpuMs: netAt(breakEven.cpuMs.savingMedian, breakEven.cpuMs.trainingMedian),
  };

  // §6 integrity: an unauthorized run must be refused and leave no stray write.
  const probeItem = rows[0].task;
  const probeFile = `src/${probeItem}.js`;
  installArith(roots.learned, ARITH_RETENTION[0]);
  commit(roots.learned);
  const probeContentBefore = fs.readFileSync(path.join(roots.learned, probeFile), 'utf8');
  const unauthorized = spawnSync(process.execPath, [CLI, 'coder', `${probeItem}.json`, '--adapt-memory',
    '--root', roots.learned, '--journal', path.join(roots.learned, 'journal.db'),
    '--run-id', `${probeItem}-unauthorized`, '--json'],
  { cwd: roots.learned, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(roots.learned, '.huqan', 'runtime-state') } });
  const unauthorizedResult = JSON.parse(unauthorized.stdout);
  const probeRefused = unauthorizedResult?.data?.outcome === 'needs_human_decision'
    && fs.readFileSync(path.join(roots.learned, probeFile), 'utf8') === probeContentBefore;
  const approvalBypass = ['applied', 'applied_tested'].includes(unauthorizedResult?.data?.outcome) ? 1 : 0;

  const sealedAll = rows.every(row =>
    sealedManifest(roots.learned, `${row.task}:c1`).learningEligibility === 'positive_procedure');

  // §8 decision order: integrity, then sufficiency, then the label.
  const integrityHeld = wrongWrites.count === 0 && approvalBypass === 0;
  const breakEvenReached = breakEven.wallMs.reached && breakEven.cpuMs.reached;
  const netPositive = amortizedNet.wallMs !== null && amortizedNet.wallMs > 0
    && amortizedNet.cpuMs !== null && amortizedNet.cpuMs > 0;
  let label;
  if (!integrityHeld) label = 'REJECT';
  else if (!marginProvable || !measured) label = 'INSUFFICIENT';
  else if (retentionNonInferior && retentionMarginMet && breakEvenReached && netPositive) label = 'GAIN';
  else label = 'MEASURED_NO_GAIN';

  const report = {
    preregistration: CONTRACT.preregistration,
    source: 'sealed synthesis run journal (real CLI + journal store + sealed read)',
    sourceRevision: { commit: process.env.GITHUB_SHA || null,
      sealedRuns: {
        training: Object.fromEntries([ARITH_TRAIN.name, STRING_TRAIN.name]
          .map(name => [name, sealedSource(roots.learned, name)])),
        retention: Object.fromEntries(rows.map(row => [row.task, sealedSource(roots.learned, row.task)])),
      } },
    cohort: { families: ['arithmetic-expression', 'string-expression'],
      retentionPerFamily: CONTRACT.retentionPerFamily, retentionSize,
      requiredSamplesForMargin: CONTRACT.requiredSamplesForMargin, marginProvable },
    retention: { pooled, perFamily, scope: 'previously-learned-skill-retained-after-later-learning',
      nonInferior: retentionNonInferior, marginMet: retentionMarginMet,
      priorSkillRetained, margin: CONTRACT.nonInferiorityMargin },
    training: { repeats: training.wallMs.length, wallMs: training.wallMs, cpuMs: training.cpuMs, rssKb: training.rssKb },
    breakEven,
    savingInterval,
    amortizedNet,
    metrics: { wrongWrites: wrongWrites.count, approvalBypass, probeRefused, costMeasured: measured },
    verdict: { status: 'MEASURED', label, assertsGain: false },
  };
  t.diagnostic(JSON.stringify(report));

  // Pins are the platform-independent invariants: the deterministic retention
  // (every task dispatched and non-inferior), the margin-provability floor, a
  // measured cost sample, the sealed source and the absence of wrong writes.
  // The wall/CPU magnitudes and the final label are reported, not pinned — the
  // #4464 lesson is that pinning a timing verdict is the flake.
  assert.deepEqual(wrongWrites.mismatches, [], `wrong writes (label ${label})`);
  assert.equal(sealedAll, true, 'every retention run is a sealed positive procedure');
  assert.equal(retentionSize, 2 * CONTRACT.retentionPerFamily, 'cohort size is the locked one');
  assert.equal(retentionNonInferior, true, 'the learned memory stays non-inferior on fresh tasks');
  assert.equal(priorSkillRetained, true, 'the previously learned family-A skill is still dispatched');
  assert.equal(marginProvable, true, 'the locked margin is provable at this cohort size');
  assert.equal(measured, true, 'wall/CPU/RSS samples are complete');
  assert.equal(probeRefused, true, 'an unauthorized run is refused and writes nothing');
  assert.equal(approvalBypass, 0, 'no approval bypass is measured');
  const sealedEntries = Object.values(report.sourceRevision.sealedRuns)
    .flatMap(group => Object.values(group));
  assert.ok(sealedEntries.length > 0, 'the report binds contributing runs to sealed sources');
  for (const entry of sealedEntries) {
    assert.ok(entry && entry.closed === true && /^[0-9a-f]{64}$/.test(entry.sourceHash),
      `unsealed contributing run: ${JSON.stringify(entry)}`);
  }
  assert.equal(report.verdict.assertsGain, false);
  assert.ok(['GAIN', 'MEASURED_NO_GAIN', 'INSUFFICIENT'].includes(label), label);
});

// §2 fail-closed: an unknown run is refused by the sealed source.
test('the sealed source refuses an unknown run (fail-closed, §2)', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-breakeven-refuse-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { journal, close } = openCoderJournal(path.join(root, 'journal.db'));
  try {
    const missing = readSealedRun(journal, 'never-ran:c1', 'default');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'run_not_found');
  } finally { close(); }
});

// §6 break-even fail-closed: a non-positive saving has no finite horizon, and an
// unmeasured saving stays unmeasured — never a favourable constant.
test('the break-even horizon has no finite value when the per-use saving is not positive', () => {
  const horizon = saving => (saving > 0 ? Math.ceil(1600 / saving) : null);
  assert.equal(horizon(50), 32);
  assert.equal(horizon(0), null);
  assert.equal(horizon(-12), null);
});
