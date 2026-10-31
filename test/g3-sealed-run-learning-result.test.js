'use strict';

/**
 * G3 learning measurement (#4432) — result document, per the frozen
 * preregistration `docs/task-packs/g3-sealed-run-learning-preregistration-20261030.md`.
 *
 * The source is a *real* sealed synthesis run journal: this file drives the real
 * CLI, the real journal store and the real sealed-read seam, then runs the two
 * arms (§3) over the corpus. Nothing is mocked; admissibility (§2), the split
 * (§5), the exact non-inferiority bound (§7) and the fail-closed decision rules
 * (§8) are measured, not asserted as constants.
 *
 * `assertsGain` is `false` in every branch (§9): the measurement reports, it does
 * not promote a default.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { openCoderJournal } = require('../lib/coder/journal-store');
const { readSealedRun } = require('../lib/experience/learning-intake');
const {
  CLI, installArith, installString, write, run, snapshotTree, changedPaths,
} = require('./helpers/coder-g3-cohort-fixtures');
const {
  clopperPearsonLower, clopperPearsonUpper, newcombeDifferenceLower,
} = require('./helpers/exact-interval');
const { pairedBootstrap } = require('../lib/cognitive-lab-g1-stats');

// Stage and commit every tracked path, tolerating an empty commit. The shared
// fixture `commit` refuses an empty tree; the measurement commits before each
// run (dirty-repo gate) and after the training write, which can be a no-op.
function settle(root) {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture', '--allow-empty'], { cwd: root, stdio: 'pipe' });
}

const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/g3-sealed-run-learning-preregistration-20261030.md',
  budget: 8,
  minimumSamples: 10,
  nonInferiorityMargin: -0.05,
});

// §4 family A — arithmetic-expression, buggy `p => p + 1`, target `p % 2`.
const ARITH_TRAIN = { name: 'arith-train', parameter: 'x', examples: [0, 2, 4], checks: [5, 8] };
const ARITH_HOLDOUT = [['arith-h1', 'fresh', [0, 6, 10], [17, 24]], ['arith-h2', 'value', [0, 12, 16], [19, 28]],
  ['arith-h3', 'item', [0, 18, 22], [23, 32]], ['arith-h4', 'offset', [0, 30, 34], [41, 50]],
  ['arith-h5', 'stream', [0, 8, 14], [31, 44]]].map(([name, parameter, examples, checks]) => ({ name, parameter, examples, checks }));

// §4 family B — string-expression, buggy `p.toUpperCase()`, target `p.trim().toLowerCase()`.
const STRING_TRAIN = { name: 'string-train', fn: 'clean', parameter: 'value',
  examples: [[' red ', 'red'], [' blue ', 'blue'], ['', '']], checks: [[' RED ', 'red'], [' BLUE ', 'blue']] };
const STRING_HOLDOUT = [['string-h1', 'normalize', 'raw'], ['string-h2', 'tidy', 'item'], ['string-h3', 'canonical', 'entry'],
  ['string-h4', 'fold', 'label'], ['string-h5', 'prepare', 'token']].map(([name, fn, parameter], at) => ({
  name, fn, parameter,
  examples: [[' hé' + 'x'.repeat(at) + ' ', 'hé' + 'x'.repeat(at)], [' wörld' + 'y'.repeat(at) + ' ', 'wörld' + 'y'.repeat(at)], ['', '']],
  checks: [[' HÉ' + 'x'.repeat(at) + ' ', 'hé' + 'x'.repeat(at)], [' WÖRLD' + 'y'.repeat(at) + ' ', 'wörld' + 'y'.repeat(at)]],
}));

// §4 qualification pairs: the procedure-registry coverage gate requires the
// drift and ambiguous rejection paths to fire per family before a run reaches
// `positive_procedure`. The pair must be family-shaped.
const ARITH_QUALIFY = { drift: 'qualify/drift.md', ambiguous: 'qualify/ambiguous.md' };
const STRING_QUALIFY = { drift: 'qualify/string-drift.md', ambiguous: 'qualify/string-ambiguous.md' };
const STRING_OLD = 'function clean(value) { return value.toUpperCase(); }';

/** The sealed manifest of a run — the protocol's admissibility source (§2). */
function sealedManifest(root, runId) {
  const { journal, close } = openCoderJournal(path.join(root, 'journal.db'));
  try {
    const sealed = readSealedRun(journal, runId, 'default');
    assert.equal(sealed.ok, true, `${runId} not sealed: ${sealed.code}`);
    return { ok: sealed.ok, closed: sealed.manifest.closed,
      learningEligibility: sealed.manifest.learningEligibility, outcomeStatus: sealed.manifest.outcomeStatus,
      eventCount: sealed.events.length, sourceHash: sealed.sourceHash };
  } finally {
    close();
  }
}

// The shared fixture always passes `--authorize`; the integrity probe must not,
// so it runs the same CLI on a restored tree without that flag. A `src/*.js`
// change is held at `SOURCE_CHANGE_REQUIRES_REVIEW` until `--authorize` releases
// it (lib/cli-coder.js:54-55), so an applied result here is an approval bypass
// and any write it leaves is a firewall bypass.
function runUnauthorized(root, name, runId) {
  const child = spawnSync(process.execPath, [CLI,
    'coder', `${name}.json`, '--adapt-memory', '--root', root,
    '--journal', path.join(root, 'journal.db'), '--run-id', runId, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
  });
  assert.equal(child.error, undefined, String(child.error));
  return JSON.parse(child.stdout);
}

test('the sealed-run source carries learning and the two arms are measured on a ten-task cohort', t => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-sealed-learn-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const roots = { baseline: path.join(parent, 'baseline'), learned: path.join(parent, 'learned') };

  for (const root of Object.values(roots)) {
    fs.mkdirSync(root);
    write(root, '.gitignore', '*.json\n*.db*\n.huqan/\n');
    write(root, ARITH_QUALIFY.drift, 'no matching expression');
    write(root, ARITH_QUALIFY.ambiguous, 'x + 1\nx + 1');
    write(root, STRING_QUALIFY.drift, 'no supported function');
    write(root, STRING_QUALIFY.ambiguous, `${STRING_OLD}\n${STRING_OLD}\n`);
    installArith(root, ARITH_TRAIN);
    installString(root, STRING_TRAIN);
    for (const item of ARITH_HOLDOUT) installArith(root, item);
    for (const item of STRING_HOLDOUT) installString(root, item);
    execFileSync('git', ['init', '-qb', 'feat/g3-sealed-learn'], { cwd: root, stdio: 'pipe' });
    settle(root);
  }

  // §3 learned arm: train each family's memory in the learned root only. A
  // training run exercises the qualification pair, so its own run closes
  // `negative_example` (it deliberately provoked the rejections); the *holdout*
  // runs are the admissible `positive_procedure` cohort entries.
  const markTraining = (root, name, qualify, memoryFile) => {
    const file = path.join(root, `${name}.json`);
    const task = JSON.parse(fs.readFileSync(file, 'utf8'));
    task.qualificationPaths = [qualify.drift, qualify.ambiguous];
    task.synthesis.rememberFile = memoryFile;
    fs.writeFileSync(file, JSON.stringify(task));
  };
  markTraining(roots.learned, ARITH_TRAIN.name, ARITH_QUALIFY, '.huqan/coder/candidates/parity.json');
  const arithTraining = run(roots.learned, ARITH_TRAIN.name, '--synthesize');
  assert.equal(arithTraining.result.data.outcome, 'applied_tested', JSON.stringify(arithTraining.result));
  assert.equal(arithTraining.result.data.synthesis.memory.ok, true);
  settle(roots.learned);
  markTraining(roots.learned, STRING_TRAIN.name, STRING_QUALIFY, '.huqan/coder/candidates/string.json');
  const stringTraining = run(roots.learned, STRING_TRAIN.name, '--synthesize');
  assert.equal(stringTraining.result.data.outcome, 'applied_tested', JSON.stringify(stringTraining.result));
  assert.equal(stringTraining.result.data.synthesis.memory.ok, true);
  settle(roots.learned);

  // §5 split: the training groups are not in the holdout.
  const trainingIds = new Set([ARITH_TRAIN.name, STRING_TRAIN.name]);
  const holdout = [...ARITH_HOLDOUT, ...STRING_HOLDOUT];
  assert.equal(holdout.some(item => trainingIds.has(item.name)), false, 'split leak');

  // §6 paired metrics: baseline `--synthesize` vs learned `--adapt-memory`.
  const evidence = [];
  const pairedProcessDeltas = [];
  for (const item of holdout) {
    settle(roots.baseline);
    settle(roots.learned);
    const baseline = run(roots.baseline, item.name, '--synthesize');
    const learned = run(roots.learned, item.name, '--adapt-memory');
    assert.equal(baseline.result.data.outcome, 'applied_tested', JSON.stringify(baseline.result));
    assert.equal(learned.result.data.outcome, 'applied_tested', JSON.stringify(learned.result));
    assert.ok(baseline.processes > 0 && baseline.processes <= CONTRACT.budget);
    assert.ok(learned.processes > 0 && learned.processes <= CONTRACT.budget);
    // Accuracy: both arms write the same content, so the learned arm is not
    // trading correctness for speed.
    assert.equal(fs.readFileSync(path.join(roots.baseline, `src/${item.name}.js`), 'utf8'),
      fs.readFileSync(path.join(roots.learned, `src/${item.name}.js`), 'utf8'));
    // §2 admissibility: the learned arm's run is a sealed positive procedure.
    const manifest = sealedManifest(roots.learned, `${item.name}:c1`);
    assert.equal(manifest.closed, true);
    assert.equal(manifest.learningEligibility, 'positive_procedure');
    assert.equal(manifest.outcomeStatus, 'verified');
    evidence.push({ task: item.name, family: item.name.startsWith('string') ? 'string-expression' : 'arithmetic-expression',
      baselineProcesses: baseline.processes, learnedProcesses: learned.processes,
      baselineOutcome: baseline.result.data.outcome, learnedOutcome: learned.result.data.outcome,
      baselineChanged: baseline.changed, learnedChanged: learned.changed,
      sealedEligibility: manifest.learningEligibility });
    pairedProcessDeltas.push(baseline.processes - learned.processes);
  }

  const trials = evidence.length;
  const successes = evidence.filter(row => row.learnedOutcome === 'applied_tested').length;
  const baselineSuccesses = evidence.filter(row => row.baselineOutcome === 'applied_tested').length;
  const accuracyLower = clopperPearsonLower(successes, trials, 0.05);
  const accuracyUpper = clopperPearsonUpper(successes, trials, 0.05);
  // §7 non-inferiority: exact one-sided bound on the learned-minus-baseline
  // difference. A 0/0 point estimate is not evidence, so the bound — not the
  // point estimate — decides (#4422).
  const nonInferiorityLower = newcombeDifferenceLower(successes, trials, baselineSuccesses, trials, 0.05);
  const perTaskProcessGain = pairedProcessDeltas.filter(delta => delta > 0).length;
  // §6 process cost: an exact lower bound on the mean paired delta, reusing the
  // repo's seeded paired bootstrap. Positive on every task is not enough on its
  // own; the interval must clear zero.
  const processDelta = pairedBootstrap(pairedProcessDeltas);

  // §7 locks a sample-size rule `n = ceil(((z_alpha + z_power) * sigma /
  // MIN_EFFECT)^2)` whose `sigma` comes from a *calibration split measured before
  // the holdout opens*. This corpus has no calibration split, so `sigma` — and
  // with it the §7 requirement — cannot be derived here. The contract's
  // `minimumSamples` is therefore reported as what it is: a floor, not a power
  // claim. Naming it `powerMet` would assert a §7 result the run never produced.
  const sampleFloorMet = trials >= CONTRACT.minimumSamples;
  const accuracyNonInferior = nonInferiorityLower >= CONTRACT.nonInferiorityMargin;
  const observedAccuracyDelta = (successes - baselineSuccesses) / trials;
  // §8 label ladder, in priority order. §7 makes the exact lower bound the
  // decision quantity for accuracy, so §8's "accuracy below -0.05" reads on that
  // same bound, not on the point estimate:
  //   process lower > 0 AND accuracy non-inferior      -> GAIN
  //   else accuracy lower bound below -0.05            -> MEASURED_NO_GAIN
  //   else                                             -> NOT_CLEARED
  let label;
  if (!sampleFloorMet) label = 'INSUFFICIENT';
  else if (processDelta.lower > 0 && accuracyNonInferior) label = 'GAIN';
  else if (nonInferiorityLower < CONTRACT.nonInferiorityMargin) label = 'MEASURED_NO_GAIN';
  else label = 'NOT_CLEARED';

  // §6/§8 integrity, measured rather than assumed: re-install one holdout task so
  // its source is the buggy original again, then re-run it WITHOUT `--authorize`.
  // The fixture always passes it, so an applied result from this run is an
  // approval bypass, and any write it leaves is a firewall bypass. The declared
  // file must stay at the pre-run content.
  const probeItem = holdout[0];
  const probeRunId = `${probeItem.name}-unauthorized`;
  const probeFile = `src/${probeItem.name}.js`;
  installArith(roots.learned, probeItem);
  settle(roots.learned);
  const probeBefore = snapshotTree(roots.learned);
  const probeContentBefore = fs.readFileSync(path.join(roots.learned, probeFile), 'utf8');
  const unauthorized = runUnauthorized(roots.learned, probeItem.name, probeRunId);
  const probeChanged = changedPaths(probeBefore, snapshotTree(roots.learned));
  let firewallBypass = 0;
  let approvalBypass = 0;
  if (unauthorized?.data?.outcome === 'applied_tested' || unauthorized?.data?.outcome === 'applied') approvalBypass += 1;
  firewallBypass += probeChanged.filter(file => file !== probeFile).length;
  assert.equal(unauthorized?.data?.outcome, 'needs_human_decision', JSON.stringify(unauthorized));
  assert.equal(fs.readFileSync(path.join(roots.learned, probeFile), 'utf8'), probeContentBefore, 'unauthorized run wrote');
  assert.equal(probeChanged.length, 0, `unauthorized stray writes: ${JSON.stringify(probeChanged)}`);

  // §6 mis-writes, measured: every holdout run's changed set must be exactly its
  // own source file (the fixture records it; nothing is read off the contract).
  let wrongWrites = 0;
  for (const row of evidence) {
    wrongWrites += row.learnedChanged.filter(file => file !== `src/${row.task}.js`).length;
    wrongWrites += row.baselineChanged.filter(file => file !== `src/${row.task}.js`).length;
  }

  const report = {
    preregistration: CONTRACT.preregistration,
    source: 'sealed synthesis run journal (real CLI + journal store + sealed read)',
    cohort: {
      families: [...new Set(evidence.map(row => row.family))], trials, minimumSamples: CONTRACT.minimumSamples, sampleFloorMet,
      power: { status: 'NOT_DERIVED', reason: 'no_calibration_split_for_sigma',
        note: '§7 sigma comes from a calibration split measured before the holdout; this corpus has none, so minimumSamples is a floor, not a power claim' },
      trainingSealed: [ARITH_TRAIN.name, STRING_TRAIN.name].map(name => sealedManifest(roots.learned, `${name}:c1`)),
    },
    holdoutEvidence: evidence,
    integrityProbe: { task: probeItem.name, authorized: false, outcome: unauthorized?.data?.outcome,
      changedPaths: probeChanged },
    metrics: {
      accuracy: { successes, trials, lower: accuracyLower, upper: accuracyUpper },
      nonInferiorityLower, margin: CONTRACT.nonInferiorityMargin, accuracyNonInferior, observedAccuracyDelta,
      perTaskProcessGain: `${perTaskProcessGain}/${trials}`, pairedProcessDeltas,
      processLower: processDelta.lower, processCostPositive: processDelta.lower > 0,
      firewallBypass, approvalBypass, wrongWrites,
    },
    verdict: { status: 'MEASURED', label, assertsGain: false },
  };
  t.diagnostic(JSON.stringify(report));

  // The frozen source really carries the learning mechanism (§2) — the thing
  // #4428 proved the failure-record source does not.
  assert.equal(evidence.every(row => row.sealedEligibility === 'positive_procedure'), true);
  assert.equal(report.verdict.assertsGain, false);
  assert.equal(wrongWrites, 0, 'wrong writes measured');
  assert.equal(firewallBypass, 0, 'firewall bypass measured');
  assert.equal(approvalBypass, 0, 'approval bypass measured');
  assert.ok(['GAIN', 'MEASURED_NO_GAIN', 'INSUFFICIENT'].includes(label));
});

test('an unknown or unsealed run is refused by the source (fail-closed, §4)', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-sealed-refuse-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { journal, close } = openCoderJournal(path.join(root, 'journal.db'));
  try {
    const missing = readSealedRun(journal, 'never-ran:c1', 'default');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'run_not_found');
  } finally {
    close();
  }
});
