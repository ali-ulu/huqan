'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');

// Preregistration: docs/task-packs/coder-learning-gain-accuracy-cost-preregistration-20261027.md
// Thresholds were locked before this evaluation ever ran; they mirror §7 there.
const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/coder-learning-gain-accuracy-cost-preregistration-20261027.md',
  budget: 8,
  holdoutSize: 5,
  wrongWriteTolerance: 0,
});

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const BUDGET = CONTRACT.budget;
// Declared before training; fixture files are only installed afterwards. Same-method
// arithmetic/parity transfers; parameter names and value ranges vary per task.
const HOLDOUT = [
  { name: 'first', parameter: 'fresh', examples: [0, 6, 10], checks: [17, 24] },
  { name: 'second', parameter: 'value', examples: [0, 12, 16], checks: [19, 28] },
  { name: 'third', parameter: 'item', examples: [0, 18, 22], checks: [23, 32] },
  { name: 'fourth', parameter: 'seed', examples: [0, 26, 30], checks: [35, 42] },
  { name: 'fifth', parameter: 'count', examples: [0, 40, 46], checks: [47, 58] },
];

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function commit(root) {
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['add', 'src', 'test', 'qualify', '.gitignore']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
}

function commandFixture(name, checks, expected) {
  return `const fs = require('node:fs'); fs.mkdirSync('.huqan/gain', { recursive: true });
fs.appendFileSync('.huqan/gain/${name}.log', 'test-process\\n');
const assert = require('node:assert/strict'); const f = require('../src/${name}');
${checks.map(input => `assert.equal(f(${input}), ${expected(input)});`).join('\n')}
`;
}

function install(root, item, expected = input => input % 2) {
  const content = `module.exports = ${item.parameter} => ${item.parameter} + 1;\n`;
  const task = { id: item.name, level: 'l0', allowedPaths: [`src/${item.name}.js`],
    operation: { type: 'replace_text', path: `src/${item.name}.js` },
    test: { command: `node test/${item.name}.js` },
    synthesis: { family: 'arithmetic-expression',
      examples: item.examples.map(input => ({ input, expected: expected(input) })) } };
  write(root, `src/${item.name}.js`, content);
  write(root, `test/${item.name}.js`, commandFixture(item.name, item.checks, expected));
  write(root, `${item.name}.json`, JSON.stringify(task));
  return { task, content, taskHash: digest(JSON.stringify(task)), testHash: digest(commandFixture(item.name, item.checks, expected)) };
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

test('preregistered paired eval: learned arm holds accuracy and cuts amortized total cost', t => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gain-eval-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const roots = { baseline: path.join(parent, 'baseline'), learned: path.join(parent, 'learned') };
  for (const root of Object.values(roots)) {
    fs.mkdirSync(root);
    write(root, '.gitignore', '*.json\n*.db*\n.huqan/\n');
    install(root, { name: 'training', parameter: 'x', examples: [0, 2, 4], checks: [5, 8] });
    write(root, 'qualify/drift.md', 'no matching expression');
    write(root, 'qualify/ambiguous.md', 'x + 1\nx + 1');
    execFileSync('git', ['init', '-qb', 'feat/gain-eval'], { cwd: root, stdio: 'pipe' });
    commit(root);
  }
  const trainingFile = path.join(roots.learned, 'training.json');
  const trainingTask = JSON.parse(fs.readFileSync(trainingFile, 'utf8'));
  trainingTask.qualificationPaths = ['qualify/drift.md', 'qualify/ambiguous.md'];
  trainingTask.synthesis.rememberFile = '.huqan/coder/candidates/parity.json';
  fs.writeFileSync(trainingFile, JSON.stringify(trainingTask));
  const training = run(roots.learned, 'training', '--synthesize');
  assert.equal(training.result.data.outcome, 'applied_tested');
  assert.equal(training.result.data.synthesis.memory.ok, true);
  commit(roots.learned);
  const trainingSourceHash = digest(fs.readFileSync(path.join(roots.learned, 'src/training.js'), 'utf8'));
  const candidateHash = digest(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/parity.json'), 'utf8'));

  const evidence = [];
  let baselineProcesses = 0, learnedProcesses = 0, baselineWallMs = 0, learnedWallMs = 0;
  for (const item of HOLDOUT) {
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
  }

  // Distribution-shift / different-method control: matching repair context must not
  // make the memory solve a new family, and there must be no automatic fallback.
  const novel = { name: 'novel', parameter: 'next', examples: [0, 1, 2], checks: [7, 11] };
  const novelExpected = input => input * input + 1;
  const novelFixture = install(roots.learned, novel, novelExpected);
  install(roots.baseline, novel, novelExpected);
  for (const root of Object.values(roots)) commit(root);
  const rejected = run(roots.learned, novel.name, '--adapt-memory', 6);
  const fresh = run(roots.baseline, novel.name, '--synthesize');
  assert.equal(rejected.result.data.outcome, 'needs_human_decision');
  assert.equal(rejected.result.data.attempts[0].rolledBack, true);
  assert.equal(fs.readFileSync(path.join(roots.learned, 'src/novel.js'), 'utf8'), novelFixture.content);
  assert.deepEqual(execFileSync('git', ['status', '--porcelain'], { cwd: roots.learned, encoding: 'utf8' }).split('\n').filter(Boolean), []);
  assert.equal(fresh.result.data.outcome, 'applied_tested');

  // Previous-skill non-inferiority: after the negative control, the learned arm
  // must still replay the remembered parity procedure on a new same-family task.
  const regression = { name: 'regression', parameter: 'stream', examples: [0, 8, 14], checks: [31, 44] };
  const regressionFixture = install(roots.learned, regression);
  install(roots.baseline, regression);
  for (const root of Object.values(roots)) commit(root);
  const stillLearned = run(roots.learned, 'regression', '--adapt-memory');
  const stillBaseline = run(roots.baseline, 'regression', '--synthesize');
  assert.equal(stillLearned.result.data.outcome, 'applied_tested');
  assert.equal(stillBaseline.result.data.outcome, 'applied_tested');
  assert.ok(stillLearned.processes < stillBaseline.processes);

  // Restart persistence: every CLI call was already a fresh process; reopen the
  // journal store and confirm the eligibility ledger survived.
  const store = openCoderJournal(path.join(roots.learned, 'journal.db'));
  try {
    for (const item of HOLDOUT) assert.equal(store.journal.manifest(`${item.name}:c1`).learningEligibility, 'positive_procedure');
    assert.equal(store.journal.manifest('novel:c1').learningEligibility, 'negative_example');
    assert.equal(store.journal.manifest('regression:c1').learningEligibility, 'positive_procedure');
  } finally { store.close(); }
  assert.equal(digest(fs.readFileSync(path.join(roots.learned, 'src/training.js'), 'utf8')), trainingSourceHash);
  assert.equal(digest(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/parity.json'), 'utf8')), candidateHash);

  const perTaskProcessGain = evidence.filter(row => row.learnedProcesses < row.baselineProcesses).length;
  const report = {
    preregistration: CONTRACT.preregistration, scope: 'same-method (arithmetic/parity) paired transfer eval',
    contract: CONTRACT, training: { processes: training.processes, wallMs: Math.round(training.wallMs) },
    holdoutEvidence: evidence, holdoutSize: evidence.length,
    totals: { baselineProcesses, learnedProcesses,
      amortizedSavedProcesses: baselineProcesses - learnedProcesses - training.processes,
      baselineHoldoutWallMs: Math.round(baselineWallMs), learnedHoldoutWallMs: Math.round(learnedWallMs),
      trainingWallMs: Math.round(training.wallMs),
      amortizedWallGainMs: Math.round(baselineWallMs - learnedWallMs - training.wallMs),
      cpuCost: 'NOT_MEASURED (no cross-platform child-CPU sampling without new dependencies)' },
    differentMethodControl: { memoryRejected: true, outcome: rejected.result.data.outcome, rolledBack: true,
      freshSynthesisSucceeded: true, automaticFallback: false, sourceUnchanged: true },
    restartPersistence: { journalReopened: true, manifestSurvived: true, trainingSourceUnchanged: true, candidateUnchanged: true },
    previousSkillNonInferiority: { task: 'regression', baselineProcesses: stillBaseline.processes,
      learnedProcesses: stillLearned.processes, held: stillLearned.processes < stillBaseline.processes },
    metricVerdicts: {
      accuracy: 'MEASURED', wrongWrites: CONTRACT.wrongWriteTolerance === 0 ? 'REJECT_THRESHOLD_UNTRIGGERED' : 'REJECT',
      perTaskProcessGain: `${perTaskProcessGain}/${evidence.length}`,
      amortizedWallGainMs: 'reported', cpuCost: 'NOT_MEASURED',
    },
  };
  t.diagnostic(JSON.stringify(report));
});
