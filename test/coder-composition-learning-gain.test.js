'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const positive = input => input.filter(item => item > 0);
const square = input => input.map(item => item * item);
const sum = input => input.reduce((acc, item) => acc + item, 0);
const selectedSum = input => sum(square(positive(input)));
const rows = (inputs, fn) => inputs.map(input => ({ input, expected: fn(input) }));
const specOf = () => ({ kind: 'project_spec', name: 'filter-source', archetype: 'node_computed_json_api', routes: [
  { path: '/selected-total', pipeline: ['/positive', '/square', '/sum'],
    acceptanceExamples: rows([[5, -2, 3], [4, 0, -3, 8], [6, -7]], selectedSum) },
  { path: '/positive', compute: { family: 'array-filter', examples: rows([[], [-1, 0, 1], [2, -2, 2]], positive),
    acceptanceExamples: rows([[-5, 9, 0, 1], [4, -3, 8], [-2, -3]], positive) } },
  { path: '/square', compute: { family: 'array-map', examples: rows([[], [2], [3, 4]], square),
    acceptanceExamples: rows([[-3, 8], [1, 1, 1], [20]], square) } },
  { path: '/sum', compute: { family: 'array-fold', examples: rows([[], [2], [3, 4]], sum),
    acceptanceExamples: rows([[-3, 8], [1, 1, 1], [20]], sum) } },
] });

// Declared before any source training. Both arms receive identical requirements,
// acceptance tests and search budgets; only the remembered whole chain differs.
const COHORT = [
  { name: 'first-chain-transfer', train: [[], [30, -4], [-9, 31]], heldout: [[43, -8], [44, 45, -9], [46, -10, 47]] },
  { name: 'second-chain-transfer', train: [[], [50, -12], [-13, 51]], heldout: [[63, -14], [64, 65, -15], [66, -16, 67]], field: 'values' },
  { name: 'third-chain-transfer', train: [[], [70, -17], [-18, 71]], heldout: [[83, -19], [84, 85, -20], [86, -21, 87]] },
];
const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const BUDGET = 32768;

test('paired project transfers count source replay and amortize remembered-chain search separately from native verification', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-gain-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'codex/chain-gain']); fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture'); git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const requirements = COHORT.map(item => ({ kind: 'project_spec', name: item.name, archetype: 'node_computed_json_api', routes: [
    { path: '/answer', ...(item.field ? { inputField: item.field } : {}),
      pipeline: { family: 'array-fold', inferFromMemory: true, examples: rows(item.train, selectedSum) },
      acceptanceExamples: rows(item.heldout, selectedSum) },
  ] }));
  const hashes = requirements.map(spec => digest(JSON.stringify(spec)));
  assert.equal(new Set(hashes).size, 3);
  let sequence = 0;
  const run = (spec, files, out) => {
    sequence += 1; const root = path.join(base, `target-${sequence}`); fs.mkdirSync(root);
    const file = path.join(base, `spec-${sequence}.json`); fs.writeFileSync(file, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', file,
      '--root', root, '--initialize-project', '--source-root', source, '--journal', path.join(base, 'journal.db'),
      ...[].concat(files).flatMap(file => ['--project-memory', file]), ...(out ? ['--project-memory-out', out] : []),
      '--run-id', `gain-${sequence}`, '--json'], { cwd: base, encoding: 'utf8', timeout: 120000, windowsHide: true,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') } });
    assert.equal(child.error, undefined, String(child.error));
    return { root, child, data: JSON.parse(child.stdout).data };
  };
  const foundations = specOf().routes.slice(1).map((route, at) => {
    const file = path.join(base, `foundation-${at}.json`);
    const result = run({ kind: 'project_spec', name: `foundation-${at}`, archetype: 'node_computed_json_api', routes: [route] }, file);
    assert.equal(result.child.status, 0, JSON.stringify(result.data));
    return { file, bytes: fs.readFileSync(file, 'utf8'), nativeChecks: result.data.attempts.length };
  });
  const files = foundations.map(source => source.file);
  const chainFile = path.join(base, 'remembered-chain.json');
  const training = run({ kind: 'project_spec', name: 'chain-training', archetype: 'node_computed_json_api', routes: [
    { path: '/trained', pipeline: { family: 'array-fold', inferFromMemory: true, examples: rows([[], [6, -1], [-2, 3]], selectedSum) },
      acceptanceExamples: rows([[13, -4], [8, 5, -7], [7, -9, 10]], selectedSum) },
  ] }, files, chainFile);
  assert.equal(training.child.status, 0, JSON.stringify(training.data));
  const chainBytes = fs.readFileSync(chainFile, 'utf8');
  const trainingSearch = training.data.plan.computation.pipelines[0].enumerated + training.data.projectMemory.replaySearch;
  assert.equal(trainingSearch, 14); assert.equal(training.data.projectMemory.replaySearch, 0);
  const evidence = [];
  for (let at = 0; at < requirements.length; at += 1) {
    const spec = requirements[at];
    const baseline = run(spec, files); const learned = run(spec, chainFile);
    for (const result of [baseline, learned]) {
      assert.equal(result.child.status, 0, JSON.stringify(result.data));
      assert.equal(result.data.outcome, 'applied_tested');
      assert.equal(result.data.attempts.length, 1);
      assert.equal(result.data.attempts[0].test.exitCode, 0);
      assert.equal(result.data.record.observedVerification.ok, true);
    }
    const baselineSearch = baseline.data.plan.computation.pipelines[0].enumerated + baseline.data.projectMemory.replaySearch;
    const learnedSearch = learned.data.plan.computation.pipelines[0].enumerated + learned.data.projectMemory.replaySearch;
    assert.equal(baselineSearch, 14); assert.equal(learnedSearch, 0);
    assert.ok(baselineSearch <= BUDGET && learnedSearch <= BUDGET);
    assert.equal(digest(JSON.stringify(spec)), hashes[at]);
    const outputHashes = {};
    for (const file of baseline.data.plan.files) {
      const left = fs.readFileSync(path.join(baseline.root, file));
      assert.deepEqual(fs.readFileSync(path.join(learned.root, file)), left);
      outputHashes[file] = digest(left);
    }
    evidence.push({ name: spec.name, requirementsHash: hashes[at], outputHashes, budget: BUDGET,
      baselineSearch, learnedSearch, baselineNativeChecks: baseline.data.attempts.length, learnedNativeChecks: learned.data.attempts.length });
  }
  const negative = JSON.parse(JSON.stringify(requirements[0])); negative.name = 'wrong-heldout-control';
  negative.routes[0].acceptanceExamples[0].expected += 1;
  const rejected = run(negative, chainFile);
  assert.equal(rejected.child.status, 6, JSON.stringify(rejected.data));
  assert.equal(rejected.data.attempts[0].rolledBack, true); assert.deepEqual(fs.readdirSync(rejected.root), []);
  assert.equal(fs.readFileSync(chainFile, 'utf8'), chainBytes);
  const altered = JSON.parse(chainBytes); altered.programs[0].stages.unshift(JSON.parse(JSON.stringify(altered.programs[0].stages[0])));
  delete altered.hash; altered.hash = digest(JSON.stringify(altered));
  fs.writeFileSync(chainFile, JSON.stringify(altered));
  const forgedChain = run(requirements[0], chainFile);
  assert.equal(forgedChain.child.status, 6, JSON.stringify(forgedChain.data));
  assert.equal(forgedChain.data.reason, 'PROJECT_MEMORY_OUTPUT_MISMATCH');
  assert.deepEqual(fs.readdirSync(forgedChain.root), []);
  fs.writeFileSync(chainFile, chainBytes);

  for (const source of foundations) assert.equal(fs.readFileSync(source.file, 'utf8'), source.bytes);
  const baselineSearch = evidence.reduce((sum, row) => sum + row.baselineSearch, 0);
  const learnedSearch = evidence.reduce((sum, row) => sum + row.learnedSearch, 0);
  const report = { scope: 'paired same-chain transfer from verified primitive repertoire', cohortSize: evidence.length,
    commonPrimitiveTrainingNativeChecks: foundations.reduce((sum, source) => sum + source.nativeChecks, 0),
    extraChainTrainingSearch: trainingSearch, extraChainTrainingNativeChecks: training.data.attempts.length,
    baselineSearch, learnedSearch, amortizedSavedSearch: baselineSearch - learnedSearch - trainingSearch,
    baselineNativeChecks: 3, learnedNativeChecks: 3, amortizedSavedNativeChecks: -training.data.attempts.length,
    generalSoftwareLearningGain: 'NOT_MEASURED', wrongAcceptanceControl: 'rolled_back', evidence };
  assert.equal(report.amortizedSavedSearch, 28); assert.equal(report.amortizedSavedNativeChecks, -1);
  t.diagnostic(JSON.stringify(report));
});
