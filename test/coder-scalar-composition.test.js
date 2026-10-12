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
  const output = execFileSync(process.execPath, ['--test', 'test/api.test.js'], { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
  assert.match(output, /# fail 0/u);
  const changedAcceptance = projectSpec();
  changedAcceptance.routes[2].acceptanceExamples[0].expected = 123;
  const wrong = produceComputedProject(changedAcceptance);
  assert.equal(wrong.ok, true);
  assert.equal(wrong.files['src/logic.js'], result.files['src/logic.js']);
  fs.writeFileSync(path.join(directory, 'test/api.test.js'), wrong.files['test/api.test.js']);
  assert.throws(() => execFileSync(process.execPath, ['--test', 'test/api.test.js'], {
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
