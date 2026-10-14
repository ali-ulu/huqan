'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchMemoryScalarCompositions, inspectProjectProgram } = require('../lib/coder/project-programs');
const { searchStatefulFoldPrograms } = require('../lib/experience/array-stateful-fold-program');
const { produceProject } = require('../lib/coder/project-producer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const sourceInputs = [[], [2, 5], [5, 2], [3, 1, 4], [-4, -2], [-2, 7, 1]];
const extrema = (input, minimum) => {
  const sorted = [...input].sort((a, b) => a - b);
  return sorted.length ? sorted[minimum ? 0 : sorted.length - 1] : 0;
};
const primitives = [false, true].map(minimum => searchStatefulFoldPrograms({ examples:
  sourceInputs.map(input => ({ input, expected: extrema(input, minimum) })) }).candidates[0].program);
const examples = [[10, -5], [20, 3], [7, 8]].map(input => ({ input,
  expected: extrema(input, false) - extrema(input, true) }));
test('discovers an untrained arithmetic composition without declared source routes', () => {
  const searched = searchMemoryScalarCompositions({ candidatePrograms: primitives, examples });
  assert.equal(searched.sourcePoolSize, 2);
  assert.equal(searched.matchingExpressions, 1);
  assert.equal(searched.enumerated, 12);
  const method = inspectProjectProgram(searched.candidates[0].program);
  for (const input of [[], [42], [-100, -30], [-30, -100], [9, 9, 9], [-1000000, 1000000]])
    assert.equal(method.evaluate(input), extrema(input, false) - extrema(input, true));
});
test('canonical identity ignores pool order, duplicates and unused source programs', () => {
  const selected = searchMemoryScalarCompositions({ candidatePrograms: primitives, examples }).candidates[0];
  const unrelated = { ...primitives[0], seed: 'empty', emptyResult: 0, update: { type: 'integer', value: 0 } };
  const reordered = searchMemoryScalarCompositions({ candidatePrograms: [primitives[1], unrelated, primitives[0], primitives[1]], examples });
  assert.equal(reordered.sourcePoolSize, 3);
  assert.equal(reordered.matchingExpressions, 1);
  assert.equal(reordered.candidates[0].program.sources.length, 2);
  assert.equal(reordered.candidates[0].canonicalExpression, selected.canonicalExpression);
});
test('supports a single useful source and refuses an over-budget depth before partial selection', () => {
  const single = searchMemoryScalarCompositions({ candidatePrograms: [primitives[0]], examples:
    examples.map(row => ({ input: row.input, expected: extrema(row.input, false) })) });
  assert.equal(single.matchingExpressions, 1);
  assert.equal(single.enumerated, 1);
  assert.equal(single.candidates[0].program.sources.length, 1);
  const pool = Array.from({ length: 8 }, (_, emptyResult) => ({ ...primitives[0], emptyResult }));
  const over = searchMemoryScalarCompositions({ candidatePrograms: pool, examples });
  assert.equal(over.reason, 'SCALAR_COMPOSITION_SEARCH_OVER_CAP');
  assert.equal(over.enumerated, 144);
  assert.deepEqual(over.candidates, []);
  assert.ok(over.searchSpace > over.searchBudget);
});
test('discovers a shallow solution in a larger pool without changing program identity or budget', () => {
  const baseline = searchMemoryScalarCompositions({ candidatePrograms: primitives, examples });
  const extras = Array.from({ length: 6 }, (_, at) => ({ type: 'stateful-fold', seed: 'empty', emptyResult: at + 1,
    guard: { operator: '===' }, update: { type: 'acc' } }));
  const expanded = searchMemoryScalarCompositions({ candidatePrograms: [...extras, ...primitives], examples });
  assert.equal(expanded.sourcePoolSize, 8);
  assert.equal(expanded.matchingExpressions, 1);
  assert.equal(expanded.enumerated, 144);
  assert.equal(expanded.searchBudget, baseline.searchBudget);
  assert.ok(expanded.enumerated <= expanded.searchBudget);
  assert.equal(expanded.candidates[0].canonicalExpression, baseline.candidates[0].canonicalExpression);
});
test('rejects executable or malformed memory proposals without invoking getters', () => {
  let calls = 0;
  const result = searchMemoryScalarCompositions({ get candidatePrograms() { calls += 1; return primitives; }, examples });
  assert.equal(result.reason, 'SCALAR_COMPOSITION_MEMORY_INVALID');
  assert.equal(calls, 0);
  assert.equal(searchMemoryScalarCompositions({ candidatePrograms: [{ type: 'unknown' }], examples }).reason, 'SCALAR_COMPOSITION_MEMORY_INVALID');
});
function memoryOptions() {
  return { candidatePrograms: primitives, methodContexts: primitives.map(program => ({
    canonicalExpression: inspectProjectProgram(program).canonicalExpression, trainingInputs: sourceInputs
  })) };
}
function targetSpec() {
  return { kind: 'project_spec', name: 'discovered-range', archetype: 'node_computed_json_api', routes: [{
    path: '/answer', composeScalar: { inferFromMemory: true, examples },
    acceptanceExamples: [[-100, -30], [42], [-1000000, 1000000]].map(input => ({ input,
      expected: extrema(input, false) - extrema(input, true) }))
  }] };
}
test('produces one declared route using memory-discovered sources, without acceptance selection', () => {
  const spec = targetSpec();
  const result = produceProject(spec, memoryOptions());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.plan.computation.family, 'scalar-composition');
  assert.equal(result.plan.computation.routes.length, 1);
  assert.equal(result.plan.computation.routes[0].source, 'memory-composition');
  assert.equal(result.plan.computation.routes[0].enumerated, 12);
  const routes = result.task.operation.steps.find(step => step.path === 'routes.json');
  assert.deepEqual(JSON.parse(routes.content), [{ path: '/answer' }]);
  spec.routes[0].acceptanceExamples[0].expected = 123;
  const wrong = produceProject(spec, memoryOptions());
  assert.equal(wrong.ok, true, wrong.reason);
  assert.deepEqual(wrong.plan.computation.routes, result.plan.computation.routes);
});
test('refuses missing ancestry and source-training holdout leakage after discovery', () => {
  const missing = { candidatePrograms: primitives, methodContexts: [] };
  assert.equal(produceProject(targetSpec(), missing).reason, 'PROJECT_COMPUTE_METHOD_CONTEXT_MISSING');
  const sparse = memoryOptions();
  sparse.methodContexts[0].trainingInputs = Array(1);
  assert.equal(produceProject(targetSpec(), sparse).reason, 'PROJECT_COMPUTE_METHOD_CONTEXT_MISSING');
  const leak = targetSpec(); leak.routes[0].acceptanceExamples[0] = { input: [2, 5], expected: 3 };
  assert.equal(produceProject(leak, memoryOptions()).reason, 'PROJECT_COMPUTE_SCALAR_HOLDOUT_OVERLAP');
  const mixed = targetSpec(); mixed.routes[0].composeScalar.sources = ['/maximum', '/minimum'];
  assert.equal(produceProject(mixed, memoryOptions()).reason, 'PROJECT_COMPUTE_SCALAR_INVALID');
});
test('native CLI discovers from sealed primitives, saves and reopens the method, and rolls back wrong acceptance', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-discovery-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']); fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture');
  git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  const primitiveFile = path.join(base, 'primitives.json'), methodFile = path.join(base, 'method.json');
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  let sequence = 0;
  const run = (spec, memory, out) => {
    sequence += 1; const root = path.join(base, `target-${sequence}`); fs.mkdirSync(root);
    const specFile = path.join(base, `spec-${sequence}.json`); fs.writeFileSync(specFile, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', specFile,
      '--root', root, '--initialize-project', '--source-root', source, '--journal', path.join(base, 'journal.db'),
      '--project-memory', memory, ...(out ? ['--project-memory-out', out] : []), '--run-id', `discovery-${sequence}`, '--json'],
    { cwd: base, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result, root };
  };
  const primitiveSpec = { kind: 'project_spec', name: 'sealed-extrema', archetype: 'node_computed_json_api', routes:
    [false, true].map(minimum => ({ path: minimum ? '/min' : '/max', compute: { family: 'array-stateful-fold',
      examples: sourceInputs.map(input => ({ input, expected: extrema(input, minimum) })),
      acceptanceExamples: [[6, 9], [-8, -3], [22]].map(input => ({ input, expected: extrema(input, minimum) }))
    } })) };
  for (let value = 1; value <= 6; value += 1) primitiveSpec.routes.push({ path: `/constant-${value}`, compute: {
    family: 'array-stateful-fold', examples: [...sourceInputs, [101]].map(input => ({ input, expected: value })),
    acceptanceExamples: [[6, 9], [-8, -3], [22]].map(input => ({ input, expected: value }))
  } });
  const trained = run(primitiveSpec, primitiveFile);
  assert.equal(trained.child.status, 0, JSON.stringify(trained.result));
  const primitiveBytes = fs.readFileSync(primitiveFile, 'utf8');
  assert.equal(JSON.parse(primitiveBytes).programs.some(program => program.type === 'scalar-composition'), false);
  assert.equal(JSON.parse(primitiveBytes).programs.length, 8);
  const discovered = run(targetSpec(), primitiveFile, methodFile);
  assert.equal(discovered.child.status, 0, JSON.stringify(discovered.result));
  assert.equal(discovered.result.data.plan.computation.routes[0].enumerated, 144);
  assert.equal(discovered.result.data.plan.computation.routes[0].sourcePoolSize, 8);
  assert.equal(discovered.result.data.attempts[0].test.exitCode, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(discovered.root, 'routes.json'), 'utf8')), [{ path: '/answer' }]);
  const methodBytes = fs.readFileSync(methodFile, 'utf8');
  const reusedSpec = targetSpec(); reusedSpec.name = 'reopened-discovery'; reusedSpec.routes[0].path = '/spread';
  reusedSpec.routes[0].inputField = 'values';
  reusedSpec.routes[0].composeScalar.examples = [[-7, 14], [30, 11], [4, 9]].map(input => ({ input,
    expected: extrema(input, false) - extrema(input, true) }));
  const reopened = run(reusedSpec, methodFile);
  assert.equal(reopened.child.status, 0, JSON.stringify(reopened.result));
  assert.equal(reopened.result.data.plan.computation.routes[0].enumerated, 0);
  assert.equal(reopened.result.data.attempts[0].test.exitCode, 0);
  reusedSpec.routes[0].acceptanceExamples[0].expected = 123;
  const rejected = run(reusedSpec, methodFile);
  assert.equal(rejected.child.status, 6, JSON.stringify(rejected.result));
  assert.equal(rejected.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(rejected.root), []);
  const alteredParent = JSON.parse(primitiveBytes);
  alteredParent.sourceHash = '0'.repeat(64); delete alteredParent.hash;
  alteredParent.hash = createHash('sha256').update(JSON.stringify(alteredParent)).digest('hex');
  fs.writeFileSync(primitiveFile, JSON.stringify(alteredParent));
  try {
    const changedSource = run(targetSpec(), methodFile);
    assert.equal(changedSource.child.status, 6, JSON.stringify(changedSource.result));
    assert.equal(changedSource.result.data.reason, 'PROJECT_MEMORY_SOURCE_CHANGED');
    assert.deepEqual(fs.readdirSync(changedSource.root), []);
  } finally { fs.writeFileSync(primitiveFile, primitiveBytes); }
  assert.equal(fs.readFileSync(primitiveFile, 'utf8'), primitiveBytes);
  assert.equal(fs.readFileSync(methodFile, 'utf8'), methodBytes);
});
