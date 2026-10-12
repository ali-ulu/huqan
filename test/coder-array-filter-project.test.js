'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceProject } = require('../lib/coder/project-producer');
const { produceComputedProject } = require('../lib/coder/project-compute');
const { inspectProjectProgram } = require('../lib/coder/project-programs');
const { methodTrainingContexts, loadProjectMethods } = require('../lib/coder/project-method-memory');
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
test('filter stages compose with maps and folds and preserve shrinking array results', () => {
  const spec = specOf(); const produced = produceProject(spec); assert.equal(produced.ok, true, JSON.stringify(produced));
  const methods = produced.plan.computation.routes.map(route => route.program);
  const arraySpec = specOf(); arraySpec.routes[0].pipeline = ['/positive', '/square'];
  arraySpec.routes[0].acceptanceExamples = rows([[5, -2, 3], [4, 0, -3, 8], [6, -7]], input => square(positive(input)));
  const array = produceProject(arraySpec, { candidatePrograms: methods }); assert.equal(array.ok, true, JSON.stringify(array));
  const sandbox = { module: { exports: {} } };
  require('node:vm').runInNewContext(array.task.operation.steps.find(step => step.path === 'src/logic.js').content, sandbox);
  assert.equal(JSON.stringify(sandbox.module.exports.compute(0, [-3, 5, 0, 2])), '[25,4]');
  const invalid = specOf(); invalid.routes[1].compute.examples[1].expected = [1, 1, 1, 1];
  assert.equal(produceProject(invalid).reason, 'PROJECT_COMPUTE_EXAMPLES_INVALID');
});
test('composes verified primitives without route hints using training-only shortest-unique selection', () => {
  const source = specOf(); source.routes.shift();
  const learned = produceProject(source); assert.equal(learned.ok, true, JSON.stringify(learned));
  const options = { candidatePrograms: learned.plan.computation.routes.map(route => route.program),
    methodContexts: methodTrainingContexts(source, learned.plan.computation) };
  const spec = { kind: 'project_spec', name: 'unhinted-composition', archetype: 'node_computed_json_api', routes: [
    { path: '/answer', pipeline: { family: 'array-fold', inferFromMemory: true,
      examples: rows([[], [6, -1], [-2, 3]], selectedSum) }, acceptanceExamples: rows([[11, -2], [7, 4, -9], [5, -6, 8]], selectedSum) },
  ] };
  const produced = produceProject(spec, options); assert.equal(produced.ok, true, JSON.stringify(produced));
  const pipeline = produced.plan.computation.pipelines[0];
  assert.deepEqual(produced.plan.computation.routes, []);
  assert.equal(pipeline.source, 'memory-composition'); assert.equal(pipeline.primitiveEnumerated, 0);
  assert.equal(pipeline.enumerated, 14); assert.equal(pipeline.searchSpace, 14);
  assert.equal(pipeline.selectedLength, 3); assert.equal(pipeline.matchingShortestChains, 1);
  assert.ok(pipeline.matchingChains > 1); assert.equal(pipeline.selectionPolicy, 'shortest-unique');
  assert.equal(inspectProjectProgram(pipeline.program).evaluate([11, -2]), 121);
  const ambiguous = JSON.parse(JSON.stringify(spec)); ambiguous.routes[0].pipeline.examples = rows([[], [0], [1]], selectedSum);
  assert.equal(produceProject(ambiguous, options).reason, 'PROJECT_COMPUTE_PIPELINE_AMBIGUOUS');
  for (const input of [[2, -9], [6, -9]]) {
    const leak = JSON.parse(JSON.stringify(spec)); leak.routes[0].acceptanceExamples[0] = { input, expected: selectedSum(input) };
    assert.equal(produceProject(leak, options).reason, 'PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
  }
  assert.equal(produceProject(spec, { candidatePrograms: options.candidatePrograms }).reason, 'PROJECT_COMPUTE_METHOD_CONTEXT_MISSING');
  assert.equal(produceProject(spec).reason, 'PROJECT_COMPUTE_PIPELINE_NO_SOLUTION');
  const wrong = JSON.parse(JSON.stringify(spec)); wrong.routes[0].acceptanceExamples[0].expected = 999;
  assert.equal(produceProject(wrong, options).task.operation.steps.find(step => step.path === 'src/logic.js').content,
    produced.task.operation.steps.find(step => step.path === 'src/logic.js').content);
});
test('refuses an oversized complete composition search before evaluating any chain', () => {
  const { enumerateArrayExpressions } = require('../lib/experience/array-fold-program');
  const programs = [...enumerateArrayExpressions(false)].slice(0, 20).map(expression => ({ type: 'map', expression }));
  const methodContexts = programs.map(program => ({ canonicalExpression: inspectProjectProgram(program).canonicalExpression,
    trainingInputs: [[], [1], [2]] }));
  const spec = { kind: 'project_spec', name: 'over-cap-composition', archetype: 'node_computed_json_api', routes: [
    { path: '/answer', pipeline: { family: 'array-map', inferFromMemory: true, examples: rows([[], [1], [2]], input => input) },
      acceptanceExamples: rows([[3], [4], [5]], input => input) },
  ] };
  const refused = produceComputedProject(spec, { candidatePrograms: programs, methodContexts });
  assert.equal(refused.reason, 'PROJECT_COMPUTE_PIPELINE_SEARCH_OVER_CAP');
  assert.equal(refused.enumerated, 0); assert.ok(refused.searchSpace > refused.searchBudget);
});
test('native CLI learns a filter, reuses the whole chain without primitives and rolls back incorrect acceptance', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'filter-project-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'codex/filter-fixture']); fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture'); git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const memory = path.join(base, 'method.json'); let sequence = 0;
  const run = (spec, memoryFile = memory, memoryOut) => {
    sequence += 1; const root = path.join(base, `target-${sequence}`); fs.mkdirSync(root);
    const file = path.join(base, `spec-${sequence}.json`); fs.writeFileSync(file, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', file,
      '--root', root, '--initialize-project', '--source-root', source, '--journal', path.join(base, 'journal.db'),
      ...[].concat(memoryFile).flatMap(file => ['--project-memory', file]), ...(memoryOut ? ['--project-memory-out', memoryOut] : []), '--run-id', `filter-${sequence}`, '--json'], { cwd: base, encoding: 'utf8', timeout: 120000,
      windowsHide: true, env: { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') } });
    assert.equal(child.error, undefined, String(child.error));
    return { child, root, result: JSON.parse(child.stdout) };
  };
  const cold = run(specOf()); assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  const bytes = fs.readFileSync(memory, 'utf8'); assert.ok(JSON.parse(bytes).programs.some(program => program.type === 'filter'));
  const target = { kind: 'project_spec', name: 'filter-chain-target', archetype: 'node_computed_json_api', routes: [
    { path: '/answer', inputField: 'values', pipeline: { family: 'array-fold', reuseOnly: true,
      examples: rows([[], [6, -1], [-2, 3]], selectedSum) }, acceptanceExamples: rows([[11, -2], [7, 4, -9], [5, -6, 8]], selectedSum) },
  ] };
  const warm = run(target); assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.deepEqual(warm.result.data.plan.computation.routes, []);
  assert.equal(warm.result.data.plan.computation.pipelines[0].enumerated, 0);
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  target.routes[0].acceptanceExamples[0].expected = 999;
  const bad = run(target); assert.equal(bad.child.status, 6, JSON.stringify(bad.result));
  assert.equal(bad.result.data.attempts[0].rolledBack, true); assert.deepEqual(fs.readdirSync(bad.root), []);
  const filterOnly = specOf(); filterOnly.name = 'filter-only-target'; filterOnly.routes = [filterOnly.routes[1]];
  filterOnly.routes[0].compute.examples = rows([[], [-3, 0, 4], [1, -9, 1]], positive);
  filterOnly.routes[0].compute.acceptanceExamples = rows([[8, -3, 0], [6, -7, 10], [0, -4]], positive);
  const reused = run(filterOnly); assert.equal(reused.child.status, 0, JSON.stringify(reused.result));
  assert.equal(reused.result.data.plan.computation.routes[0].enumerated, 0);
  assert.equal(fs.readFileSync(memory, 'utf8'), bytes);
  const foundations = specOf().routes.slice(1).map((route, at) => {
    const file = path.join(base, `foundation-${at}.json`);
    const spec = { kind: 'project_spec', name: `foundation-${at}`, archetype: 'node_computed_json_api', routes: [route] };
    const result = run(spec, file); assert.equal(result.child.status, 0, JSON.stringify(result.result));
    return { file, bytes: fs.readFileSync(file, 'utf8') };
  });
  const composed = { kind: 'project_spec', name: 'learned-basis-composition', archetype: 'node_computed_json_api', routes: [
    { path: '/new-answer', pipeline: { family: 'array-fold', inferFromMemory: true,
      examples: rows([[], [6, -1], [-2, 3]], selectedSum) }, acceptanceExamples: rows([[13, -4], [8, 5, -7], [7, -9, 10]], selectedSum) },
  ] };
  const learnedChain = path.join(base, 'learned-chain.json');
  const assembled = run(composed, foundations.map(source => source.file), learnedChain);
  assert.equal(assembled.child.status, 0, JSON.stringify(assembled.result));
  assert.equal(assembled.result.data.projectMemory.state, 'remembered');
  assert.equal(JSON.parse(fs.readFileSync(learnedChain, 'utf8')).parents.length, 3);
  assert.deepEqual(assembled.result.data.plan.computation.routes, []);
  assert.equal(assembled.result.data.plan.computation.pipelines[0].source, 'memory-composition');
  assert.equal(assembled.result.data.plan.computation.pipelines[0].primitiveEnumerated, 0);
  assert.equal(assembled.result.data.plan.computation.pipelines[0].enumerated, 14);
  assert.equal(assembled.result.data.attempts[0].test.exitCode, 0);
  const rememberedBytes = fs.readFileSync(learnedChain, 'utf8');
  const restart = JSON.parse(JSON.stringify(composed)); restart.name = 'restart-chain';
  restart.routes[0].pipeline = { family: 'array-fold', reuseOnly: true,
    examples: rows([[], [9, -4], [12, -6]], selectedSum) };
  restart.routes[0].acceptanceExamples = rows([[15, -8], [14, 16, -10], [17, -11, 18]], selectedSum);
  const restored = run(restart, learnedChain);
  assert.equal(restored.child.status, 0, JSON.stringify(restored.result));
  assert.equal(restored.result.data.plan.computation.pipelines[0].enumerated, 0);
  assert.equal(fs.readFileSync(learnedChain, 'utf8'), rememberedBytes);
  const projectedLeak = JSON.parse(JSON.stringify(restart));
  projectedLeak.routes[0].acceptanceExamples[0] = { input: [6, -10], expected: 36 };
  const leaking = run(projectedLeak, learnedChain);
  assert.equal(leaking.child.status, 6, JSON.stringify(leaking.result));
  assert.equal(leaking.result.data.reason, 'PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
  assert.deepEqual(fs.readdirSync(leaking.root), []);
  projectedLeak.routes[0].acceptanceExamples[0] = { input: [2, -10], expected: 4 };
  const parentTrainingLeak = run(projectedLeak, learnedChain);
  assert.equal(parentTrainingLeak.child.status, 6, JSON.stringify(parentTrainingLeak.result));
  assert.equal(parentTrainingLeak.result.data.reason, 'PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
  assert.deepEqual(fs.readdirSync(parentTrainingLeak.root), []);
  fs.writeFileSync(foundations[0].file, '{}');
  const brokenParent = run(restart, learnedChain);
  assert.equal(brokenParent.child.status, 6, JSON.stringify(brokenParent.result));
  assert.deepEqual(fs.readdirSync(brokenParent.root), []);
  fs.writeFileSync(foundations[0].file, foundations[0].bytes);
  const crypto = require('node:crypto');
  const tampered = JSON.parse(rememberedBytes); tampered.parents.reverse();
  delete tampered.hash; tampered.hash = crypto.createHash('sha256').update(JSON.stringify(tampered)).digest('hex');
  fs.writeFileSync(learnedChain, JSON.stringify(tampered));
  const forged = run(restart, learnedChain);
  assert.equal(forged.child.status, 6, JSON.stringify(forged.result));
  assert.equal(forged.result.data.reason, 'PROJECT_MEMORY_PARENT_BINDING_MISMATCH');
  assert.deepEqual(fs.readdirSync(forged.root), []);
  fs.writeFileSync(learnedChain, rememberedBytes);
  const stripped = JSON.parse(rememberedBytes); delete stripped.parents; delete stripped.hash;
  stripped.hash = crypto.createHash('sha256').update(JSON.stringify(stripped)).digest('hex');
  fs.writeFileSync(learnedChain, JSON.stringify(stripped));
  const missingBindings = run(restart, learnedChain);
  assert.equal(missingBindings.child.status, 6, JSON.stringify(missingBindings.result));
  assert.equal(missingBindings.result.data.reason, 'PROJECT_MEMORY_PARENT_BINDING_MISMATCH');
  assert.deepEqual(fs.readdirSync(missingBindings.root), []);
  fs.writeFileSync(learnedChain, rememberedBytes);
  const overwrite = run(restart, learnedChain, learnedChain);
  assert.equal(overwrite.child.status, 6, JSON.stringify(overwrite.result));
  assert.equal(overwrite.result.data.reason, 'PROJECT_MEMORY_OUTPUT_EXISTS');
  assert.deepEqual(fs.readdirSync(overwrite.root), []);
  composed.routes[0].acceptanceExamples[0].expected = 999;
  const rejectedMemory = path.join(base, 'rejected-chain.json');
  const rejected = run(composed, foundations.map(source => source.file), rejectedMemory);
  assert.equal(fs.existsSync(rejectedMemory), false);
  assert.equal(rejected.child.status, 6, JSON.stringify(rejected.result));
  assert.equal(rejected.result.data.attempts[0].rolledBack, true); assert.deepEqual(fs.readdirSync(rejected.root), []);
  for (const source of foundations) assert.equal(fs.readFileSync(source.file, 'utf8'), source.bytes);
});


test('memory ancestry refuses cycles and excessive depth before source replay', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'method-ancestry-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'target'); const sourceRoot = path.join(base, 'source');
  fs.mkdirSync(root); fs.mkdirSync(sourceRoot);
  const files = Array.from({ length: 5 }, (_, at) => path.join(base, `method-${at}.json`));
  const parent = file => ({ file, hash: 'x', sourceHash: 'y', sourceRunId: 'z' });
  const load = () => loadProjectMethods({ file: files[0], root, sourceRoot, journal: {} });
  fs.writeFileSync(files[0], JSON.stringify({ parents: [parent(files[1])] }));
  fs.writeFileSync(files[1], JSON.stringify({ parents: [parent(files[0])] }));
  assert.equal(load().reason, 'PROJECT_MEMORY_PARENT_CYCLE');
  for (let at = 0; at < files.length; at += 1)
    fs.writeFileSync(files[at], JSON.stringify(at + 1 < files.length ? { parents: [parent(files[at + 1])] } : {}));
  assert.equal(load().reason, 'PROJECT_MEMORY_ANCESTRY_OVER_CAP');
});
