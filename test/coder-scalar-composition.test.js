'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectProjectProgram, searchScalarCompositions } = require('../lib/coder/project-programs');
const { searchStatefulFoldPrograms } = require('../lib/experience/array-stateful-fold-program');
const { produceComputedProject } = require('../lib/coder/project-compute');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const inputs = [[], [2, 5], [5, 2], [3, 1, 4], [-4, -2], [-2, 7, 1]];
// Replacement cohort declared before any training; the original preregistration
// is retained because its empty holdout overlaps mandatory source training.
const TRANSFER_COHORT = [
  { train: [[101, -11], [205, 12], [17, 18]], holdout: [[-90, -20], [-20, -90], [44]] },
  { train: [[301, -21], [405, 22], [27, 28]], holdout: [[-190, -120], [-120, -190], [144]] },
  { train: [[501, -31], [605, 32], [37, 38]], holdout: [[-290, -220], [-220, -290], [244]] },
];
function extremum(input, minimum) {
  const ordered = [...input].sort((a, b) => a - b);
  return ordered.length ? ordered[minimum ? 0 : ordered.length - 1] : 0;
}
function sources() {
  return [false, true].map(minimum => searchStatefulFoldPrograms({
    examples: inputs.map(input => ({ input, expected: extremum(input, minimum) }))
  }).candidates[0].program);
}
test('combines learned extrema from training alone and transfers to independent inputs', () => {
  const search = searchScalarCompositions({ sources: sources(), examples: [
    { input: [10, -5], expected: 15 }, { input: [20, 3], expected: 17 }, { input: [7, 8], expected: 1 }
  ] });
  assert.equal(search.candidates.length, 1);
  assert.equal(search.enumerated, 12);
  const inspected = inspectProjectProgram(search.candidates[0].program);
  for (const input of [[], [42], [-100, -30], [-30, -100], [9, 9, 9], [-1000000, 1000000]])
    assert.equal(inspected.evaluate(input), extremum(input, false) - extremum(input, true));
  assert.notEqual(inspected.evaluate([10, -5]), -15);
});
test('rejects executable inputs and keeps compiled sources and expression immutable', () => {
  let calls = 0;
  const hostile = { get sources() { calls += 1; return sources(); }, examples: [] };
  assert.equal(searchScalarCompositions(hostile).enumerated, 0);
  assert.equal(calls, 0);
  const data = { type: 'scalar-composition', sources: sources(), expression: {
    operator: '-', left: { source: 0 }, right: { source: 1 }
  } };
  const inspected = inspectProjectProgram(data);
  data.expression.operator = '+';
  data.sources = [];
  assert.equal(inspected.evaluate([10, -5]), 15);
  const sparse = [1, 2, 3];
  delete sparse[1];
  assert.throws(() => inspected.evaluate(sparse), /INPUT_INVALID/u);
});
test('rejects unsafe arithmetic during composed evaluation', () => {
  const leaf = () => ({ source: 0 });
  const expression = { operator: '*', left: leaf(), right: { operator: '*', left: leaf(), right: leaf() } };
  const inspected = inspectProjectProgram({ type: 'scalar-composition', sources: sources(), expression });
  assert.equal(inspected.ok, true);
  assert.throws(() => inspected.evaluate([1000000]), /RESULT_INVALID/u);
  assert.equal(inspected.evaluate([2]), 8);
});
function projectSpec() {
  return { kind: 'project_spec', name: 'range-api', archetype: 'node_computed_json_api', routes: [
    ...[false, true].map(minimum => ({ path: minimum ? '/min' : '/max', compute: {
      family: 'array-stateful-fold', examples: inputs.map(input => ({ input, expected: extremum(input, minimum) })),
      acceptanceExamples: [[6, 9], [-8, -3], [22]].map(input => ({ input, expected: extremum(input, minimum) }))
    } })),
    { path: '/range', composeScalar: { sources: ['/max', '/min'], examples: [
      { input: [10, -5], expected: 15 }, { input: [20, 3], expected: 17 }, { input: [7, 8], expected: 1 }
    ] }, acceptanceExamples: [[42], [-100, -30], [9, 9, 9], [-1000000, 1000000]].map(input => ({
      input, expected: extremum(input, false) - extremum(input, true)
    })) }
  ] };
}
test('canonicalizes commutative operands instead of refusing equivalent addition candidates', () => {
  const spec = projectSpec();
  for (const row of [...spec.routes[2].composeScalar.examples, ...spec.routes[2].acceptanceExamples])
    row.expected = extremum(row.input, false) + extremum(row.input, true);
  const produced = produceComputedProject(spec);
  assert.equal(produced.ok, true, produced.reason);
  assert.equal(produced.computation.routes[2].matchingExpressions, 1);
  assert.equal(produced.computation.routes[2].program.expression.operator, '+');
});
test('groups exactly equivalent safe additive reassociations at two operations', () => {
  for (const coefficient of [1, -1]) {
    const spec = projectSpec();
    for (const row of [...spec.routes[2].composeScalar.examples, ...spec.routes[2].acceptanceExamples])
      row.expected = 2 * extremum(row.input, false) + coefficient * extremum(row.input, true);
    const produced = produceComputedProject(spec);
    assert.equal(produced.ok, true, produced.reason);
    assert.equal(produced.computation.routes[2].matchingExpressions, 1);
    const selected = inspectProjectProgram(produced.computation.routes[2].program);
    assert.equal(selected.evaluate([-1000000, 1000000]), 2000000 + coefficient * -1000000);
  }
});
test('retains multiplication forms with different signed-zero refusal domains', () => {
  const a = { source: 0 }, b = { source: 1 };
  const left = inspectProjectProgram({ type: 'scalar-composition', sources: sources(), expression: {
    operator: '*', left: { operator: '*', left: a, right: b }, right: b
  } });
  const right = inspectProjectProgram({ type: 'scalar-composition', sources: sources(), expression: {
    operator: '*', left: a, right: { operator: '*', left: b, right: b }
  } });
  assert.throws(() => left.evaluate([0, -1]), /RESULT_INVALID/u);
  assert.equal(right.evaluate([0, -1]), 0);
  const search = searchScalarCompositions({ sources: sources(), examples: [[2, 3], [-3, -2], [4, 7]].map(input => ({
    input, expected: extremum(input, false) * extremum(input, true) * extremum(input, true)
  })) });
  assert.ok(search.matchingExpressions > 1);
});
test('generated application passes independent HTTP acceptance in a separate process', t => {
  const result = produceComputedProject(projectSpec());
  assert.equal(result.ok, true, result.reason);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-scalar-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(result.files)) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'test/api.test.js'], { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
  assert.match(output, /# fail 0/u);
  const changedAcceptance = projectSpec();
  changedAcceptance.routes[2].acceptanceExamples[0].expected = 123;
  const wrong = produceComputedProject(changedAcceptance);
  assert.equal(wrong.ok, true);
  assert.equal(wrong.files['src/logic.js'], result.files['src/logic.js']);
  fs.writeFileSync(path.join(directory, 'test/api.test.js'), wrong.files['test/api.test.js']);
  assert.throws(() => execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'test/api.test.js'], {
    cwd: directory, env, encoding: 'utf8', timeout: 30000, stdio: 'pipe'
  }), error => error.status === 1);
});
test('refuses training leakage and ambiguous scalar expressions', () => {
  const leaked = projectSpec();
  leaked.routes[2].acceptanceExamples[0] = { input: [10, -5], expected: 15 };
  assert.equal(produceComputedProject(leaked).reason, 'PROJECT_COMPUTE_SCALAR_HOLDOUT_OVERLAP');
  const ambiguous = projectSpec();
  ambiguous.routes[2].composeScalar.examples = [1, 4, 8].map(value => ({ input: [value], expected: value }));
  assert.equal(produceComputedProject(ambiguous).reason, 'PROJECT_COMPUTE_SCALAR_AMBIGUOUS');
});
test('composes a newly synthesized primitive after a memory miss', () => {
  const spec = projectSpec();
  spec.routes[1].compute.synthesizeOnMemoryMiss = true;
  const maximum = sources()[0];
  const result = produceComputedProject(spec, { candidatePrograms: [maximum], methodContexts: [{
    canonicalExpression: inspectProjectProgram(maximum).canonicalExpression,
    trainingInputs: inputs
  }] });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.computation.routes[1].source, 'synthesis-after-memory-miss');
  assert.equal(result.computation.routes[2].enumerated, 12);
});
test('native CLI persists composed methods, reuses in a new process and rolls back bad acceptance', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-scalar-memory-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']); fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture');
  git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  const memory = path.join(base, 'method.json');
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  let sequence = 0;
  const run = (spec, memoryFile = memory, memoryOut) => {
    sequence += 1;
    const root = path.join(base, `target-${sequence}`); fs.mkdirSync(root);
    const specFile = path.join(base, `spec-${sequence}.json`); fs.writeFileSync(specFile, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', specFile,
      '--root', root, '--initialize-project', '--source-root', source, '--journal', path.join(base, 'journal.db'),
      '--project-memory', memoryFile, ...(memoryOut ? ['--project-memory-out', memoryOut] : []), '--run-id', `scalar-${sequence}`, '--json'],
    { cwd: base, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result, root };
  };
  const cold = run(projectSpec());
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  const bytes = fs.readFileSync(memory, 'utf8');
  const target = projectSpec(); target.name = 'range-target';
  target.routes[2].path = '/spread'; target.routes[2].inputField = 'numbers';
  target.routes[2].composeScalar.examples = [
    { input: [-7, 14], expected: 21 }, { input: [30, 11], expected: 19 }, { input: [4, 9], expected: 5 }
  ];
  const warm = run(target);
  assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.equal(warm.result.data.plan.computation.routes[2].enumerated, 0);
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  target.routes[2].acceptanceExamples[0].expected = 123;
  const rejected = run(target);
  assert.equal(rejected.child.status, 6, JSON.stringify(rejected.result));
  assert.equal(rejected.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(rejected.root), []);
  assert.equal(fs.readFileSync(memory, 'utf8'), bytes);
  const primitiveSpec = projectSpec(); primitiveSpec.name = 'frozen-extrema'; primitiveSpec.routes.pop();
  const primitiveFile = path.join(base, 'frozen-primitives.json');
  const primitiveRun = run(primitiveSpec, primitiveFile);
  assert.equal(primitiveRun.child.status, 0, JSON.stringify(primitiveRun.result));
  const frozenBytes = fs.readFileSync(primitiveFile, 'utf8');
  assert.equal(JSON.parse(frozenBytes).programs.some(program => program.type === 'scalar-composition'), false);
  const cost = result => result.result.data.plan.computation.routes.reduce((sum, row) => sum + row.enumerated, 0)
    + (result.result.data.projectMemory?.replaySearch || 0);
  const report = { scope: 'new scalar composition from frozen extrema', budgetPerArm: 65536,
    sourceTrainingSearch: cost(primitiveRun), coldTargetSearch: 0, frozenTargetSearch: 0,
    coldNativeChecks: 0, frozenNativeChecks: primitiveRun.result.data.attempts.length,
    originalPreregistration: 'INSUFFICIENT_SOURCE_HOLDOUT_OVERLAP', generalLearningGain: 'NOT_MEASURED', pairs: [] };
  assert.equal(report.sourceTrainingSearch, 96);
  for (let at = 0; at < TRANSFER_COHORT.length; at += 1) {
    const item = TRANSFER_COHORT[at];
    const spec = projectSpec(); spec.name = `paired-range-${at}`;
    const range = input => extremum(input, false) - extremum(input, true);
    spec.routes[2].composeScalar.examples = item.train.map(input => ({ input, expected: range(input) }));
    spec.routes[2].acceptanceExamples = item.holdout.map(input => ({ input, expected: range(input) }));
    const training = new Set([...inputs, ...item.train].map(input => JSON.stringify(input)));
    assert.equal(item.holdout.some(input => training.has(JSON.stringify(input))), false);
    const coldPair = run(spec, path.join(base, `cold-pair-${at}.json`));
    const frozenPair = run(spec, primitiveFile);
    for (const result of [coldPair, frozenPair]) {
      assert.equal(result.child.status, 0, JSON.stringify(result.result));
      assert.equal(result.result.data.attempts[0].test.exitCode, 0);
    }
    for (const name of coldPair.result.data.plan.files)
      assert.deepEqual(fs.readFileSync(path.join(coldPair.root, name)), fs.readFileSync(path.join(frozenPair.root, name)));
    const coldSearch = cost(coldPair), frozenSearch = cost(frozenPair);
    assert.equal(coldSearch, 108); assert.equal(frozenSearch, 12);
    report.coldTargetSearch += coldSearch; report.frozenTargetSearch += frozenSearch;
    report.coldNativeChecks += coldPair.result.data.attempts.length;
    report.frozenNativeChecks += frozenPair.result.data.attempts.length;
    report.pairs.push({ name: spec.name, coldSearch, frozenSearch });
  }
  report.amortizedSavedSearch = report.coldTargetSearch - report.sourceTrainingSearch - report.frozenTargetSearch;
  assert.equal(report.amortizedSavedSearch, 192);
  assert.equal(report.coldNativeChecks, 3); assert.equal(report.frozenNativeChecks, 4);
  assert.ok(report.coldTargetSearch <= report.budgetPerArm);
  assert.ok(report.sourceTrainingSearch + report.frozenTargetSearch <= report.budgetPerArm);
  assert.equal(fs.readFileSync(primitiveFile, 'utf8'), frozenBytes);
  t.diagnostic(JSON.stringify(report));
  const derived = projectSpec(); derived.name = 'inverse-range';
  for (const row of [...derived.routes[2].composeScalar.examples, ...derived.routes[2].acceptanceExamples]) row.expected *= -1;
  // Singletons have mathematical zero; do not introduce signed zero.
  for (const row of [...derived.routes[2].composeScalar.examples, ...derived.routes[2].acceptanceExamples])
    if (Object.is(row.expected, -0)) row.expected = 0;
  const derivedFile = path.join(base, 'derived.json');
  const learned = run(derived, memory, derivedFile);
  assert.equal(learned.child.status, 0, JSON.stringify(learned.result));
  assert.equal(learned.result.data.plan.computation.routes[2].enumerated, 12);
  const reopened = run(derived, derivedFile);
  assert.equal(reopened.child.status, 0, JSON.stringify(reopened.result));
  assert.equal(reopened.result.data.plan.computation.routes[2].enumerated, 0);
  assert.equal(fs.readFileSync(memory, 'utf8'), bytes);
});
