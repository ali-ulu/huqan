'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');

// Preregistration: docs/task-packs/coder-learning-g3-cohort-preregistration-20261030.md
// Thresholds were locked before this evaluation ever ran; they mirror §7 there.
const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/coder-learning-g3-cohort-preregistration-20261030.md',
  budget: 8,
  holdoutPerFamily: 3,
  wrongWriteTolerance: 0,
});

const digest = text => crypto.createHash('sha256').update(text).digest('hex');

// Preregistration §7/§8 verdict vocabulary: a metricVerdict classifies the
// measured metric, not the test run's exit status. 'GAIN' requires a measured
// positive gain AND every other gate to hold; a measured value that fails its
// threshold is fail-closed 'INSUFFICIENT', and an unmeasured value stays
// 'NOT_MEASURED'.
function classifyWallGainVerdict(gainMs, gatesPass) {
  if (!Number.isFinite(gainMs)) return 'NOT_MEASURED';
  return gainMs > 0 && gatesPass ? 'GAIN' : 'INSUFFICIENT';
}

test('amortized wall-gain verdict is classified per preregistered thresholds (§7)', () => {
  assert.equal(classifyWallGainVerdict(334, true), 'GAIN');
  assert.equal(classifyWallGainVerdict(0, true), 'INSUFFICIENT');
  assert.equal(classifyWallGainVerdict(-334, true), 'INSUFFICIENT');
  assert.equal(classifyWallGainVerdict(Number.NaN, true), 'NOT_MEASURED');
  assert.equal(classifyWallGainVerdict(334, false), 'INSUFFICIENT');
});

const BUDGET = CONTRACT.budget;

// §4 family A — arithmetic-expression. Buggy `p => p + 1`, target `p % 2`.
// Training and holdout examples are all even, so parity is not separable from
// the buggy expression by examples alone; the real test decides.
const ARITH_TRAIN = { name: 'training', parameter: 'x', examples: [0, 2, 4], checks: [5, 8] };
const ARITH_HOLDOUT = [
  { name: 'first', parameter: 'fresh', examples: [0, 6, 10], checks: [17, 24] },
  { name: 'second', parameter: 'value', examples: [0, 12, 16], checks: [19, 28] },
  { name: 'third', parameter: 'item', examples: [0, 18, 22], checks: [23, 32] },
];
const ARITH_SHIFT = { name: 'shift', parameter: 'offset', examples: [0, 30, 34], checks: [41, 50] };
const ARITH_REGRESSION = { name: 'regression', parameter: 'stream', examples: [0, 8, 14], checks: [31, 44] };
const ARITH_NOVEL = { name: 'novel', parameter: 'next', examples: [0, 1, 2], checks: [7, 11] };
// §4 family B — string-expression. Buggy `fn(p) { return p.toUpperCase(); }`,
// target `p.trim().toLowerCase()`. Synthesis examples are lower-case so several
// programs match; the real test uses upper-case inputs, so the exact program is
// later in the search order. Examples choose the search order, never the answer.
const STRING_OLD = 'function clean(value) { return value.toUpperCase(); }';
const STRING_TRAIN = { name: 'string-training', fn: 'clean', parameter: 'value',
  examples: [[' red ', 'red'], [' blue ', 'blue'], ['', '']],
  checks: [[' RED ', 'red'], [' BLUE ', 'blue']] };
const STRING_HOLDOUT = [
  { name: 'string-one', fn: 'normalize', parameter: 'raw',
    examples: [[' héllo ', 'héllo'], [' world ', 'world'], ['', '']],
    checks: [[' HÉLLO ', 'héllo'], [' WORLD ', 'world']] },
  { name: 'string-two', fn: 'tidy', parameter: 'item',
    examples: [[' green ', 'green'], [' yellow ', 'yellow'], ['', '']],
    checks: [[' GREEN ', 'green'], [' YELLOW ', 'yellow']] },
  { name: 'string-three', fn: 'canonical', parameter: 'entry',
    examples: [[' purple ', 'purple'], [' orange ', 'orange'], ['', '']],
    checks: [[' PURPLE ', 'purple'], [' ORANGE ', 'orange']] },
];
const STRING_SHIFT = { name: 'string-shift', fn: 'fold', parameter: 'label',
  examples: [[' été ', 'été'], [' çay ', 'çay'], ['', '']],
  checks: [[' ÉTÉ ', 'été'], [' ÇAY ', 'çay']] };

// Each family carries its own qualification pair: the procedure-registry
// coverage gate requires the drift and ambiguous rejection paths to have fired
// per `(workspaceId, kind)`, so a string procedure needs string-shaped
// qualification fixtures, not the arithmetic ones.
const ARITH_QUALIFY = { drift: 'qualify/drift.md', ambiguous: 'qualify/ambiguous.md' };
const STRING_QUALIFY = { drift: 'qualify/string-drift.md', ambiguous: 'qualify/string-ambiguous.md' };

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function commit(root) {
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['add', 'src', 'test', 'qualify', '.gitignore']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
}

function arithFixture(name, checks, expected = input => input % 2) {
  return `const fs = require('node:fs'); fs.mkdirSync('.huqan/gain', { recursive: true });
fs.appendFileSync('.huqan/gain/${name}.log', 'test-process\\n');
const assert = require('node:assert/strict'); const f = require('../src/${name}');
${checks.map(input => `assert.equal(f(${input}), ${expected(input)});`).join('\n')}
`;
}

function installArith(root, item, expected = input => input % 2) {
  const content = `module.exports = ${item.parameter} => ${item.parameter} + 1;\n`;
  const task = { id: item.name, level: 'l0', allowedPaths: [`src/${item.name}.js`],
    operation: { type: 'replace_text', path: `src/${item.name}.js` },
    test: { command: `node test/${item.name}.js` },
    synthesis: { family: 'arithmetic-expression',
      examples: item.examples.map(input => ({ input, expected: expected(input) })) } };
  write(root, `src/${item.name}.js`, content);
  write(root, `test/${item.name}.js`, arithFixture(item.name, item.checks, expected));
  write(root, `${item.name}.json`, JSON.stringify(task));
  return { task, content, taskHash: digest(JSON.stringify(task)), testHash: digest(arithFixture(item.name, item.checks, expected)) };
}

function stringFixture(name, checks) {
  return `const fs = require('node:fs'); fs.mkdirSync('.huqan/gain', { recursive: true });
fs.appendFileSync('.huqan/gain/${name}.log', 'test-process\\n');
const assert = require('node:assert/strict'); const f = require('../src/${name}');
${checks.map(([input, expected]) => `assert.equal(f(${JSON.stringify(input)}), ${JSON.stringify(expected)});`).join('\n')}
`;
}

function installString(root, item) {
  const content = `function ${item.fn}(${item.parameter}) { return ${item.parameter}.toUpperCase(); }\nmodule.exports = ${item.fn};\n`;
  const task = { id: item.name, level: 'l0', allowedPaths: [`src/${item.name}.js`],
    operation: { type: 'replace_text', path: `src/${item.name}.js` },
    test: { command: `node test/${item.name}.js` },
    synthesis: { family: 'string-expression', functionName: item.fn,
      examples: item.examples.map(([input, expected]) => ({ input, expected })) } };
  write(root, `src/${item.name}.js`, content);
  write(root, `test/${item.name}.js`, stringFixture(item.name, item.checks));
  write(root, `${item.name}.json`, JSON.stringify(task));
  return { task, content, taskHash: digest(JSON.stringify(task)), testHash: digest(stringFixture(item.name, item.checks)) };
}

function run(root, name, mode, expectedStatus = 0) {
  const started = process.hrtime.bigint();
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'cli.js'),
    'coder', `${name}.json`, mode, '--authorize', '--root', root,
    '--journal', path.join(root, 'journal.db'), '--run-id', name, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, expectedStatus, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout);
  const log = path.join(root, '.huqan', 'gain', `${name}.log`);
  const processes = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('test-process').length - 1 : 0;
  return { result, processes, wallMs };
}

// Zero mis-write tolerance: after a paired run the only tree modification must be
// the task's own source file (test JSON and test fixture were committed beforehand).
function assertNoStrayWrites(root, name) {
  const lines = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.deepEqual(lines, [` M src/${name}.js`], `stray writes in ${root}: ${lines.join(' | ')}`);
}

test('preregistered G3 cohort: learned arms hold accuracy and cut amortized total cost in two families', t => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-cohort-')));
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
    execFileSync('git', ['init', '-qb', 'feat/g3-cohort'], { cwd: root, stdio: 'pipe' });
    commit(root);
  }

  const markTraining = (root, name, qualify, memoryFile) => {
    const file = path.join(root, `${name}.json`);
    const task = JSON.parse(fs.readFileSync(file, 'utf8'));
    task.qualificationPaths = [qualify.drift, qualify.ambiguous];
    task.synthesis.rememberFile = memoryFile;
    fs.writeFileSync(file, JSON.stringify(task));
  };
  markTraining(roots.learned, ARITH_TRAIN.name, ARITH_QUALIFY, '.huqan/coder/candidates/parity.json');
  markTraining(roots.learned, STRING_TRAIN.name, STRING_QUALIFY, '.huqan/coder/candidates/string.json');

  const arithTraining = run(roots.learned, ARITH_TRAIN.name, '--synthesize');
  assert.equal(arithTraining.result.data.outcome, 'applied_tested', JSON.stringify(arithTraining.result));
  assert.equal(arithTraining.result.data.synthesis.memory.ok, true);
  commit(roots.learned);
  const stringTraining = run(roots.learned, STRING_TRAIN.name, '--synthesize');
  assert.equal(stringTraining.result.data.outcome, 'applied_tested', JSON.stringify(stringTraining.result));
  assert.equal(stringTraining.result.data.synthesis.memory.ok, true);
  commit(roots.learned);
  const trainingWallMs = arithTraining.wallMs + stringTraining.wallMs;
  const trainingProcesses = arithTraining.processes + stringTraining.processes;
  const arithTrainingHash = digest(fs.readFileSync(path.join(roots.learned, `src/${ARITH_TRAIN.name}.js`), 'utf8'));
  const stringTrainingHash = digest(fs.readFileSync(path.join(roots.learned, `src/${STRING_TRAIN.name}.js`), 'utf8'));
  const arithCandidateHash = digest(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/parity.json'), 'utf8'));
  const stringCandidateHash = digest(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/string.json'), 'utf8'));

  const evidence = [];
  let baselineProcesses = 0, learnedProcesses = 0, baselineWallMs = 0, learnedWallMs = 0;
  const pair = (install, item) => {
    const baselineFixture = install(roots.baseline, item);
    const learnedFixture = install(roots.learned, item);
    assert.equal(baselineFixture.taskHash, learnedFixture.taskHash);
    assert.equal(baselineFixture.testHash, learnedFixture.testHash);
    assert.equal(baselineFixture.content, learnedFixture.content);
    for (const root of Object.values(roots)) commit(root);
    const baseline = run(roots.baseline, item.name, '--synthesize');
    const learned = run(roots.learned, item.name, '--adapt-memory');
    for (const row of [baseline, learned]) {
      assert.equal(row.result.data.outcome, 'applied_tested', JSON.stringify(row));
      assert.ok(row.processes > 0 && row.processes <= BUDGET);
      assert.equal(row.result.data.attempts.length, row.processes);
      assert.equal(row.result.data.record.observedVerification.ok, true);
    }
    assert.ok(learned.processes < baseline.processes);
    assert.equal(fs.readFileSync(path.join(roots.baseline, `src/${item.name}.js`), 'utf8'),
      fs.readFileSync(path.join(roots.learned, `src/${item.name}.js`), 'utf8'));
    assertNoStrayWrites(roots.baseline, item.name);
    assertNoStrayWrites(roots.learned, item.name);
    evidence.push({ task: item.name, taskHash: baselineFixture.taskHash, testHash: baselineFixture.testHash,
      baselineProcesses: baseline.processes, learnedProcesses: learned.processes, maxProcesses: BUDGET,
      baselineWallMs: Math.round(baseline.wallMs), learnedWallMs: Math.round(learned.wallMs),
      attemptsEqualProcesses: true, outcome: 'applied_tested' });
    baselineProcesses += baseline.processes; learnedProcesses += learned.processes;
    baselineWallMs += baseline.wallMs; learnedWallMs += learned.wallMs;
  };
  for (const item of ARITH_HOLDOUT) pair(installArith, item);
  for (const item of STRING_HOLDOUT) pair(installString, item);

  // Distribution shift (§4, report only): same family, wider value ranges. A
  // shift task must still solve; the process saving is reported, not asserted.
  const shiftEvidence = [];
  for (const [install, item] of [[installArith, ARITH_SHIFT], [installString, STRING_SHIFT]]) {
    install(roots.baseline, item); install(roots.learned, item);
    for (const root of Object.values(roots)) commit(root);
    const baseline = run(roots.baseline, item.name, '--synthesize');
    const learned = run(roots.learned, item.name, '--adapt-memory');
    assert.equal(baseline.result.data.outcome, 'applied_tested');
    assert.equal(learned.result.data.outcome, 'applied_tested');
    assertNoStrayWrites(roots.learned, item.name);
    shiftEvidence.push({ task: item.name, baselineProcesses: baseline.processes, learnedProcesses: learned.processes });
  }

  // §4 anti-case: cross-family transfer. A root holding ONLY arithmetic memory
  // must refuse a string-expression task: no applicable candidate, source
  // unchanged, no automatic fallback write. The learned root holds both
  // memories, so this needs its own arithmetic-only root.
  const crossRoot = path.join(parent, 'arith-only');
  fs.mkdirSync(crossRoot);
  write(crossRoot, '.gitignore', '*.json\n*.db*\n.huqan/\n');
  write(crossRoot, ARITH_QUALIFY.drift, 'no matching expression');
  write(crossRoot, ARITH_QUALIFY.ambiguous, 'x + 1\nx + 1');
  installArith(crossRoot, ARITH_TRAIN);
  execFileSync('git', ['init', '-qb', 'feat/arith-only'], { cwd: crossRoot, stdio: 'pipe' });
  commit(crossRoot);
  markTraining(crossRoot, ARITH_TRAIN.name, ARITH_QUALIFY, '.huqan/coder/candidates/parity.json');
  const crossTraining = run(crossRoot, ARITH_TRAIN.name, '--synthesize');
  assert.equal(crossTraining.result.data.outcome, 'applied_tested', JSON.stringify(crossTraining.result));
  assert.equal(crossTraining.result.data.synthesis.memory.ok, true);
  commit(crossRoot);
  const crossItem = { name: 'cross-family', fn: 'shout', parameter: 'word',
    examples: [[' red ', 'red'], [' blue ', 'blue'], ['', '']],
    checks: [[' RED ', 'red'], [' BLUE ', 'blue']] };
  const crossFixture = installString(crossRoot, crossItem);
  commit(crossRoot);
  const crossRejected = run(crossRoot, crossItem.name, '--adapt-memory', 6);
  assert.equal(crossRejected.result.data.reason, 'no_applicable_candidate', JSON.stringify(crossRejected.result));
  assert.equal(crossRejected.processes, 0);
  assert.equal(fs.readFileSync(path.join(crossRoot, `src/${crossItem.name}.js`), 'utf8'), crossFixture.content);
  // The refusal must leave the tree untouched: the fixture was committed before
  // the run, so a clean status is the proof that nothing was written.
  assert.deepEqual(execFileSync('git', ['status', '--porcelain'], { cwd: crossRoot, encoding: 'utf8' })
    .split('\n').filter(Boolean), []);

  // §4 anti-case: different-method control. A matching repair context must not
  // make the memory solve a new method, and there must be no automatic fallback:
  // the memory attempt is rolled back and the fresh search does the work.
  const novelExpected = input => 2 * input + 1;
  const novelFixture = installArith(roots.learned, ARITH_NOVEL, novelExpected);
  installArith(roots.baseline, ARITH_NOVEL, novelExpected);
  for (const root of Object.values(roots)) commit(root);
  const rejected = run(roots.learned, ARITH_NOVEL.name, '--adapt-memory', 6);
  const fresh = run(roots.baseline, ARITH_NOVEL.name, '--synthesize');
  assert.equal(rejected.result.data.outcome, 'needs_human_decision');
  assert.equal(rejected.result.data.attempts[0].apply.reason, 'transfer_verification_failed');
  assert.equal(rejected.result.data.attempts[0].test.ok, false);
  assert.equal(rejected.result.data.attempts[0].rolledBack, true);
  assert.equal(rejected.processes, 1);
  assert.equal(fs.readFileSync(path.join(roots.learned, `src/${ARITH_NOVEL.name}.js`), 'utf8'), novelFixture.content);
  assert.equal(fresh.result.data.outcome, 'applied_tested');

  // §4 previous-skill non-inferiority: after the negative controls, the learned
  // arm must still replay the remembered parity procedure on a new same-family task.
  const regressionFixture = installArith(roots.learned, ARITH_REGRESSION);
  installArith(roots.baseline, ARITH_REGRESSION);
  for (const root of Object.values(roots)) commit(root);
  const stillLearned = run(roots.learned, ARITH_REGRESSION.name, '--adapt-memory');
  const stillBaseline = run(roots.baseline, ARITH_REGRESSION.name, '--synthesize');
  assert.equal(stillLearned.result.data.outcome, 'applied_tested');
  assert.equal(stillBaseline.result.data.outcome, 'applied_tested');
  assert.ok(stillLearned.processes < stillBaseline.processes);
  assertNoStrayWrites(roots.learned, ARITH_REGRESSION.name);

  // §4 restart: every CLI call was already a fresh process; reopen the journal
  // store and confirm the eligibility ledger survived.
  const store = openCoderJournal(path.join(roots.learned, 'journal.db'));
  try {
    for (const item of [...ARITH_HOLDOUT, ...STRING_HOLDOUT, ARITH_REGRESSION])
      assert.equal(store.journal.manifest(`${item.name}:c1`).learningEligibility, 'positive_procedure');
    assert.equal(store.journal.manifest(`${ARITH_NOVEL.name}:c1`).learningEligibility, 'negative_example');
  } finally { store.close(); }
  assert.equal(digest(fs.readFileSync(path.join(roots.learned, `src/${ARITH_TRAIN.name}.js`), 'utf8')), arithTrainingHash);
  assert.equal(digest(fs.readFileSync(path.join(roots.learned, `src/${STRING_TRAIN.name}.js`), 'utf8')), stringTrainingHash);
  assert.equal(digest(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/parity.json'), 'utf8')), arithCandidateHash);
  assert.equal(digest(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/string.json'), 'utf8')), stringCandidateHash);

  const perTaskProcessGain = evidence.filter(row => row.learnedProcesses < row.baselineProcesses).length;
  const amortizedWallGainMs = Math.round(baselineWallMs - learnedWallMs - trainingWallMs);
  // Every preregistered gate is a hard assert above, so reaching the report means
  // accuracy (H1a), per-task process gain (H1b) and the anti-case and restart
  // gates all held. The wall-time threshold (H1c) is the only gate classified
  // here rather than asserted: a CI timing is one observation, not an assertion.
  const wallGainVerdict = classifyWallGainVerdict(amortizedWallGainMs, true);
  // Test-run success and hypothesis success stay separate: exit 0 proves only
  // that the measurement is valid. H1 (§1) needs H1c to clear its threshold.
  const hypothesisVerdict = wallGainVerdict === 'GAIN' && perTaskProcessGain === evidence.length
    ? 'PROVEN' : 'NOT_PROVEN';
  const report = {
    preregistration: CONTRACT.preregistration, scope: 'two-family (arithmetic/parity + string/trim-lowercase) paired transfer eval',
    contract: CONTRACT,
    training: { processes: trainingProcesses, wallMs: Math.round(trainingWallMs) },
    holdoutEvidence: evidence, holdoutSize: evidence.length,
    totals: { baselineProcesses, learnedProcesses,
      amortizedSavedProcesses: baselineProcesses - learnedProcesses - trainingProcesses,
      baselineHoldoutWallMs: Math.round(baselineWallMs), learnedHoldoutWallMs: Math.round(learnedWallMs),
      trainingWallMs: Math.round(trainingWallMs),
      amortizedWallGainMs, cpuCost: 'NOT_MEASURED (no cross-platform child-CPU sampling without new dependencies)' },
    distributionShift: shiftEvidence,
    crossFamilyTransfer: { task: crossItem.name, reason: crossRejected.result.data.reason,
      sourceUnchanged: true, automaticFallback: false },
    differentMethodControl: { memoryRejected: true, outcome: rejected.result.data.outcome, rolledBack: true,
      freshSynthesisSucceeded: true, automaticFallback: false, sourceUnchanged: true },
    restartPersistence: { journalReopened: true, manifestSurvived: true,
      trainingSourcesUnchanged: true, candidatesUnchanged: true },
    previousSkillNonInferiority: { task: ARITH_REGRESSION.name, baselineProcesses: stillBaseline.processes,
      learnedProcesses: stillLearned.processes, held: stillLearned.processes < stillBaseline.processes },
    metricVerdicts: {
      accuracy: 'MEASURED', wrongWrites: CONTRACT.wrongWriteTolerance === 0 ? 'REJECT_THRESHOLD_UNTRIGGERED' : 'REJECT',
      perTaskProcessGain: `${perTaskProcessGain}/${evidence.length}`,
      amortizedWallGainMs: wallGainVerdict, cpuCost: 'NOT_MEASURED',
    },
    verdict: { testRun: 'PASSED', h1: hypothesisVerdict },
  };
  t.diagnostic(JSON.stringify(report));
});
