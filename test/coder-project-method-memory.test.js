'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const specOf = () => ({ kind: 'project_spec', name: 'squares-api', archetype: 'node_computed_json_api',
  routes: [{ path: '/squares', compute: { family: 'array-fold', examples: [
    { input: [], expected: 0 }, { input: [2], expected: 4 }, { input: [3, 4], expected: 25 },
  ], acceptanceExamples: [
    { input: [-3, 8], expected: 73 }, { input: [1, 1, 1], expected: 3 }, { input: [20], expected: 400 },
  ] } }] });
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']); fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture');
  git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  const file = path.join(base, 'method.json'); const journal = path.join(base, 'journal.db');
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  let sequence = 0;
  const run = (spec, memoryFile = file, memoryOut) => {
    sequence += 1; const root = path.join(base, `target-${sequence}`); fs.mkdirSync(root);
    const specFile = path.join(base, `spec-${sequence}.json`); fs.writeFileSync(specFile, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', specFile,
      '--root', root, '--initialize-project', '--source-root', source, '--journal', journal,
      ...[].concat(memoryFile).flatMap(file => ['--project-memory', file]),
      ...(memoryOut === undefined ? [] : ['--project-memory-out', memoryOut]), '--run-id', `memory-${sequence}`, '--json'],
    { cwd: base, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result, root };
  };
  return { run, file, source, base };
}

test('inferred family is sealed, reused in fresh CLI processes and fails closed', t => {
  const context = fixture(t);
  const spec = specOf(); delete spec.routes[0].compute.family;
  const rows = inputs => inputs.map(input => ({ input, expected: input.map(value => value * 2) }));
  spec.routes[0].compute.examples = rows([[], [2], [3, 4]]);
  spec.routes[0].compute.acceptanceExamples = rows([[-3, 8], [1, 1, 1], [20]]);
  const cold = context.run(spec);
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  assert.equal(cold.result.data.projectMemory.state, 'remembered');
  assert.equal(cold.result.data.plan.computation.family, 'array-map');
  const search = cold.result.data.plan.computation.routes[0];
  assert.ok(search.enumerated > 0);
  assert.equal(search.enumerated, search.familySearches.reduce((sum, family) => sum + family.enumerated, 0));
  const bytes = fs.readFileSync(context.file, 'utf8');
  assert.equal(Object.hasOwn(JSON.parse(bytes).sourceSpec.routes[0].compute, 'family'), false);
  const next = structuredClone(spec); next.name = 'inferred-reused-api';
  next.routes[0].path = '/reused-double'; next.routes[0].inputField = 'values';
  next.routes[0].compute.examples = rows([[], [5], [-2, 6]]);
  next.routes[0].compute.acceptanceExamples = rows([[4, -3, 8], [7], [1, 2, 3]]);
  const warm = context.run(next);
  assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.equal(warm.result.data.plan.computation.family, 'array-map');
  assert.equal(warm.result.data.plan.computation.routes[0].enumerated, 0);
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  next.routes[0].compute.acceptanceExamples[0].expected[0] = 999;
  const rejected = context.run(next);
  assert.equal(rejected.child.status, 6, JSON.stringify(rejected.result));
  assert.equal(rejected.result.data.plan.computation.routes[0].enumerated, 0);
  assert.equal(rejected.result.data.attempts[0].test.exitCode, 1);
  assert.equal(rejected.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(rejected.root), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  const forged = JSON.parse(bytes); forged.programs[0].expression = { type: 'item' };
  const { hash: discarded, ...body } = forged;
  forged.hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(context.file, JSON.stringify(forged));
  const invalid = context.run(spec);
  assert.equal(invalid.child.status, 6, JSON.stringify(invalid.result));
  assert.equal(invalid.result.data.reason, 'PROJECT_MEMORY_INVALID');
  assert.deepEqual(fs.readdirSync(invalid.root), []);
});

test('explicit memory miss synthesis learns a new project method and transfers it after restart', t => {
  const context = fixture(t);
  const cold = context.run(specOf());
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  const sourceBytes = fs.readFileSync(context.file, 'utf8');
  const target = specOf(); target.name = 'sum-after-squares'; target.routes[0].path = '/total';
  for (const group of ['examples', 'acceptanceExamples'])
    for (const row of target.routes[0].compute[group]) row.expected = row.input.reduce((acc, item) => acc + item, 0);
  const strict = context.run(target);
  assert.equal(strict.child.status, 6);
  assert.equal(strict.result.data.reason, 'PROJECT_COMPUTE_MEMORY_NO_MATCH');
  assert.deepEqual(fs.readdirSync(strict.root), []);
  target.routes[0].compute.synthesizeOnMemoryMiss = true;
  const unsaved = context.run(target);
  assert.equal(unsaved.child.status, 0, JSON.stringify(unsaved.result));
  assert.equal(unsaved.result.data.projectMemory.state, 'synthesized');
  assert.equal(fs.readFileSync(context.file, 'utf8'), sourceBytes);
  const oldMethod = specOf().routes[0];
  oldMethod.compute.examples = [{ input: [], expected: 0 }, { input: [5], expected: 25 },
    { input: [-2, 6], expected: 40 }];
  oldMethod.compute.acceptanceExamples = [{ input: [4, -3, 8], expected: 89 },
    { input: [7], expected: 49 }, { input: [1, 2, 3], expected: 14 }];
  target.routes.push(oldMethod, { path: '/report', inputField: 'values',
    compose: { total: '/total', energy: '/squares' }, acceptanceExamples: [
      { input: [4, -3, 8], expected: { total: 9, energy: 89 } },
      { input: [7], expected: { total: 7, energy: 49 } },
      { input: [1, 2, 3], expected: { total: 6, energy: 14 } },
    ] });
  const output = path.join(context.base, 'new-method.json');
  const learned = context.run(target, context.file, output);
  assert.equal(learned.child.status, 0, JSON.stringify(learned.result));
  assert.equal(learned.result.data.plan.computation.routes[0].source, 'synthesis-after-memory-miss');
  assert.ok(learned.result.data.plan.computation.routes[0].enumerated > 0);
  assert.equal(learned.result.data.plan.computation.routes[1].source, 'memory');
  assert.equal(learned.result.data.plan.computation.routes[1].enumerated, 0);
  assert.equal(learned.result.data.attempts[0].test.exitCode, 0);
  assert.equal(learned.result.data.projectMemory.ok, true);
  const bytes = fs.readFileSync(output, 'utf8');
  assert.equal(JSON.parse(bytes).programs.length, 2);
  const next = JSON.parse(JSON.stringify(target)); next.name = 'reused-new-method'; next.routes[0].path = '/aggregate';
  next.routes[0].inputField = 'values'; delete next.routes[0].compute.synthesizeOnMemoryMiss;
  next.routes[0].compute.examples = [{ input: [], expected: 0 }, { input: [5], expected: 5 }, { input: [-2, 6], expected: 4 }];
  next.routes[0].compute.acceptanceExamples = [{ input: [4, -3, 8], expected: 9 },
    { input: [7], expected: 7 }, { input: [1, 2, 3], expected: 6 }];
  next.routes[1].path = '/energy';
  next.routes[2].compose = { energy: '/energy', total: '/aggregate' };
  next.routes.reverse();
  const reused = context.run(next, output);
  assert.equal(reused.child.status, 0, JSON.stringify(reused.result));
  assert.ok(reused.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.equal(reused.result.data.attempts[0].test.exitCode, 0);
  const failedSpec = JSON.parse(JSON.stringify(target));
  failedSpec.routes[0].compute.acceptanceExamples[0].expected = 999;
  const failedOutput = path.join(context.base, 'failed-method.json');
  const failed = context.run(failedSpec, context.file, failedOutput);
  assert.equal(failed.child.status, 6, JSON.stringify(failed.result));
  assert.equal(failed.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(failed.root), []);
  assert.equal(fs.existsSync(failedOutput), false);
  assert.equal(fs.readFileSync(context.file, 'utf8'), sourceBytes);
  assert.equal(fs.readFileSync(output, 'utf8'), bytes);
});
test('sealed methods compose into structured results and transfer across route order with native rollback', t => {
  const context = fixture(t); const row = (input, expected) => ({ input, expected });
  const source = { kind: 'project_spec', name: 'summary-source', archetype: 'node_computed_json_api', routes: [
    { path: '/summary', inputField: 'values', compose: { total: '/sum', positiveCount: '/count' }, acceptanceExamples: [
      row([4, -1, 3], { total: 6, positiveCount: 2 }), row([-2, -3], { total: -5, positiveCount: 0 }), row([10, 20], { total: 30, positiveCount: 2 }),
    ] },
    { path: '/count', compute: { family: 'array-guarded-fold', examples: [row([], 0), row([0], 0), row([1], 1), row([2, -3, 4], 2), row([2], 1), row([-2], 0)],
      acceptanceExamples: [row([3], 1), row([-1], 0), row([0, 5, 6], 2)] } },
    { path: '/sum', compute: { family: 'array-fold', examples: [row([], 0), row([2], 2), row([3, 4], 7)],
      acceptanceExamples: [row([-3, 8], 5), row([1, 1, 1], 3), row([20], 20)] } },
  ] };
  const ambiguous = JSON.parse(JSON.stringify(source)); ambiguous.routes[1].compute.examples = ambiguous.routes[1].compute.examples.slice(0, 4);
  const rejected = context.run(ambiguous);
  assert.equal(rejected.child.status, 6, JSON.stringify(rejected.result));
  assert.deepEqual(fs.readdirSync(rejected.root), []);
  assert.equal(fs.existsSync(context.file), false);
  const cold = context.run(source);
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  const bytes = fs.readFileSync(context.file, 'utf8');
  assert.equal(JSON.parse(bytes).programs.length, 2);
  const target = JSON.parse(JSON.stringify(source)); target.name = 'summary-target';
  const [summary, count, sum] = target.routes;
  summary.path = '/report'; summary.inputField = 'numbers';
  sum.path = '/total'; count.path = '/positives';
  summary.compose = { positiveCount: '/positives', total: '/total' };
  summary.acceptanceExamples = [row([5, -3, 8], { positiveCount: 2, total: 10 }),
    row([6, 6], { positiveCount: 2, total: 12 }), row([-5, -10], { positiveCount: 0, total: -15 })];
  for (const route of [sum, count]) {
    const expected = input => route === sum ? input.reduce((acc, item) => acc + item, 0) : input.filter(item => item > 0).length;
    route.compute.examples = [[], [5], [-2, 6]].map(input => row(input, expected(input)));
    route.compute.acceptanceExamples = [[4, -3, 8], [7], [1, 2, 3]].map(input => row(input, expected(input)));
  }
  target.routes = [sum, count, summary];
  const warm = context.run(target);
  assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.ok(warm.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  summary.acceptanceExamples[0].expected.total = 999;
  const failed = context.run(target);
  assert.equal(failed.child.status, 6, JSON.stringify(failed.result));
  assert.deepEqual(fs.readdirSync(failed.root), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
});

test('sealed computation transfers from raw arrays to mixed object and raw request routes', t => {
  const context = fixture(t); const cold = context.run(specOf());
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  const bytes = fs.readFileSync(context.file, 'utf8');
  const target = specOf(); target.name = 'object-squares-api';
  target.routes[0].path = '/object-squares'; target.routes[0].inputField = 'values';
  target.routes[0].compute.examples = [{ input: [], expected: 0 }, { input: [5], expected: 25 }, { input: [-2, 6], expected: 40 }];
  target.routes[0].compute.acceptanceExamples = [{ input: [4, -3, 8], expected: 89 }, { input: [7], expected: 49 }, { input: [1, 2, 3], expected: 14 }];
  const rawRoute = JSON.parse(JSON.stringify(target.routes[0])); delete rawRoute.inputField;
  rawRoute.path = '/raw-squares'; target.routes.push(rawRoute);
  const warm = context.run(target);
  assert.equal(warm.child.status, 0, JSON.stringify(warm.result) + warm.child.stderr);
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.ok(warm.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  const objectMemory = path.join(context.base, 'object-method.json');
  const objectSource = context.run(target, objectMemory);
  assert.equal(objectSource.child.status, 0, JSON.stringify(objectSource.result));
  assert.equal(objectSource.result.data.projectMemory.state, 'remembered');
  const rawTarget = specOf(); rawTarget.name = 'back-to-raw';
  const back = context.run(rawTarget, objectMemory);
  assert.equal(back.child.status, 0, JSON.stringify(back.result));
  assert.equal(back.result.data.projectMemory.state, 'reused');
  assert.equal(back.result.data.plan.computation.routes[0].enumerated, 0);
});

test('native CLI remembers verified method and reuses after process restart with fresh heldouts', t => {
  const context = fixture(t); const cold = context.run(specOf());
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result) + cold.child.stderr);
  assert.equal(cold.result.data.projectMemory.state, 'remembered');
  assert.equal(cold.result.data.plan.computation.routes[0].enumerated, 7062);
  const bytes = fs.readFileSync(context.file, 'utf8');
  const warmSpec = specOf(); warmSpec.name = 'new-squares-api'; warmSpec.routes[0].path = '/new-squares';
  warmSpec.routes[0].compute.examples = [{ input: [], expected: 0 }, { input: [5], expected: 25 }, { input: [-2, 6], expected: 40 }];
  warmSpec.routes[0].compute.acceptanceExamples = [{ input: [4, -3, 8], expected: 89 }, { input: [7], expected: 49 }, { input: [1, 2, 3], expected: 14 }];
  const warm = context.run(warmSpec);
  assert.equal(warm.child.status, 0, JSON.stringify(warm.result) + warm.child.stderr);
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.equal(warm.result.data.plan.computation.routes[0].enumerated, 0);
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  warmSpec.routes[0].compute.acceptanceExamples[0].expected = 99;
  const failed = context.run(warmSpec);
  assert.equal(failed.child.status, 6, JSON.stringify(failed.result));
  assert.equal(failed.result.data.plan.computation.routes[0].enumerated, 0);
  assert.deepEqual(fs.readdirSync(failed.root), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  const saved = JSON.parse(bytes); saved.programs[0].seed = 1;
  const { hash: discarded, ...body } = saved;
  saved.hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(context.file, JSON.stringify(saved));
  const forged = context.run(specOf());
  assert.equal(forged.child.status, 6);
  assert.deepEqual(fs.readdirSync(forged.root), []);
});
test('failed native holdouts never create method memory; source overlap is refused before writes', t => {
  const context = fixture(t); const spec = specOf(); spec.routes[0].compute.acceptanceExamples[0].expected = 74;
  const failed = context.run(spec);
  assert.equal(failed.child.status, 6, JSON.stringify(failed.result));
  assert.equal(fs.existsSync(context.file), false);
  assert.deepEqual(fs.readdirSync(failed.root), []);
  const overlap = context.run(specOf(), path.join(context.source, 'method.json'));
  assert.equal(overlap.child.status, 6);
  assert.equal(overlap.result.data.reason, 'PROJECT_MEMORY_OVERLAPS_PROJECT');
  assert.deepEqual(fs.readdirSync(overlap.root), []);
});

test('a verified two-method repertoire transfers across route order and refuses an unseen method', t => {
  const context = fixture(t);
  const source = specOf();
  const sum = JSON.parse(JSON.stringify(source.routes[0])); sum.path = '/sum';
  for (const group of ['examples', 'acceptanceExamples'])
    for (const example of sum.compute[group]) example.expected = example.input.reduce((acc, item) => acc + item, 0);
  source.routes.push(sum);
  const cold = context.run(source);
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  const bytes = fs.readFileSync(context.file, 'utf8');
  assert.equal(JSON.parse(bytes).programs.length, 2);
  const target = specOf(); target.name = 'combined-transfer';
  const targetSum = JSON.parse(JSON.stringify(sum)); targetSum.path = '/new-total';
  target.routes[0].path = '/new-squares'; target.routes.unshift(targetSum);
  for (const route of target.routes) {
    const expected = input => input.reduce((acc, item) => acc + (route.path === '/new-squares' ? item * item : item), 0);
    route.compute.examples = [[], [5], [-2, 6]].map(input => ({ input, expected: expected(input) }));
    route.compute.acceptanceExamples = [[4, -3, 8], [7], [1, 2, 3]].map(input => ({ input, expected: expected(input) }));
  }
  const warm = context.run(target);
  assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.ok(warm.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  const unseen = specOf();
  for (const group of ['examples', 'acceptanceExamples'])
    for (const example of unseen.routes[0].compute[group]) example.expected = example.input.reduce((acc, item) => acc + 3 * item, 0);
  const refused = context.run(unseen);
  assert.equal(refused.child.status, 6);
  assert.equal(refused.result.data.reason, 'PROJECT_COMPUTE_MEMORY_NO_MATCH');
  assert.deepEqual(fs.readdirSync(refused.root), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
});

test('guarded methods run real HTTP heldouts and sealed mixed-family memory transfers with fresh tests', t => {
  const context = fixture(t);
  const source = specOf();
  const count = { path: '/positive-count', compute: { family: 'array-guarded-fold', examples: [
    { input: [], expected: 0 }, { input: [-1, 0, -3], expected: 0 }, { input: [1, 2, -3], expected: 2 },
    { input: [3], expected: 1 }, { input: [0], expected: 0 },
  ], acceptanceExamples: [{ input: [-4, 3, 2, 0], expected: 2 }, { input: [8, -9], expected: 1 }, { input: [0, 0], expected: 0 }] } };
  const sum = JSON.parse(JSON.stringify(count)); sum.path = '/positive-sum';
  for (const group of ['examples', 'acceptanceExamples'])
    for (const example of sum.compute[group]) example.expected = example.input.reduce((acc, item) => acc + (item > 0 ? item : 0), 0);
  source.routes.push(count, sum);
  const cold = context.run(source);
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  assert.equal(cold.result.data.plan.computation.family, 'mixed-array-fold');
  assert.deepEqual(cold.result.data.plan.computation.routes.map(route => route.enumerated), [7062, 6300, 6300]);
  const bytes = fs.readFileSync(context.file, 'utf8');
  const target = JSON.parse(JSON.stringify(source)); target.name = 'mixed-guard-transfer'; target.routes.reverse();
  for (const route of target.routes) {
    const square = route.compute.family === 'array-fold'; const counter = route.path === '/positive-count';
    route.path += '-new';
    const value = input => square ? input.reduce((acc, item) => acc + item * item, 0)
      : input.reduce((acc, item) => acc + (item > 0 ? counter ? 1 : item : 0), 0);
    route.compute.examples = [[], [2, -1, 0], [-4, 3, 5], [-3, -2], [1]].map(input => ({ input, expected: value(input) }));
    route.compute.acceptanceExamples = [[7, 0, -1], [-5, 4, 4], [0, -2, -4]].map(input => ({ input, expected: value(input) }));
  }
  const warm = context.run(target);
  assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.ok(warm.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  target.routes[0].compute.acceptanceExamples[0].expected += 1;
  const failed = context.run(target);
  assert.equal(failed.child.status, 6);
  assert.ok(failed.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.deepEqual(fs.readdirSync(failed.root), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
});

test('sealed threshold learning enables an unseen project that fresh bounded search refuses', t => {
  const context = fixture(t); const row = (input, expected) => ({ input, expected });
  const source = { kind: 'project_spec', name: 'threshold-source', archetype: 'node_computed_json_api', routes: [
    { path: '/large', compute: { family: 'array-threshold-fold', examples: [row([], 0), row([1000], 0), row([1001], 1),
      row([1000, 1500, -1], 1), row([1000, 1001, 2000], 2)],
    acceptanceExamples: [row([1800], 1), row([999, 1000], 0), row([1000, 1001, 1200], 2)] } },
  ] };
  const training = context.run(source);
  assert.equal(training.child.status, 0, JSON.stringify(training.result));
  assert.deepEqual(training.result.data.plan.computation.routes[0].program.guard, { operator: '>', threshold: 1000 });
  const bytes = fs.readFileSync(context.file, 'utf8');
  const target = JSON.parse(JSON.stringify(source)); target.name = 'unseen-threshold-project'; target.routes[0].path = '/new-large';
  target.routes[0].compute.examples = [row([], 0), row(Array.from({ length: 30 }, (_, at) => 1000 + 10 * at), 29), row([-4], 0)];
  target.routes[0].compute.acceptanceExamples = [row([-5, 1000, 1001], 1), row([1800, 2500], 2), row([10, 999], 0)];
  const frozen = JSON.stringify(target);
  const freshFile = path.join(context.base, 'fresh-method.json');
  const baseline = context.run(target, freshFile);
  assert.equal(baseline.child.status, 6);
  assert.equal(baseline.result.data.reason, 'PROJECT_COMPUTE_THRESHOLD_SEARCH_OVER_CAP');
  assert.deepEqual(fs.readdirSync(baseline.root), []); assert.equal(fs.existsSync(freshFile), false);
  const warm = context.run(target);
  assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.equal(warm.result.data.plan.computation.routes[0].enumerated, 0);
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  assert.equal(JSON.stringify(target), frozen);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
  target.routes[0].compute.acceptanceExamples[0].expected = 999;
  const failed = context.run(target);
  assert.equal(failed.child.status, 6);
  assert.deepEqual(fs.readdirSync(failed.root), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
});

test('independent sealed sources jointly solve a new composed project and reject invalid pools before writes', t => {
  const context = fixture(t);
  const sumFile = path.join(context.base, 'sum-method.json');
  const squareSource = context.run(specOf());
  assert.equal(squareSource.child.status, 0, JSON.stringify(squareSource.result));
  const sumSpec = specOf(); sumSpec.name = 'sum-source'; sumSpec.routes[0].path = '/sum';
  const total = input => input.reduce((acc, item) => acc + item, 0);
  const squares = input => input.reduce((acc, item) => acc + item * item, 0);
  for (const group of ['examples', 'acceptanceExamples'])
    for (const row of sumSpec.routes[0].compute[group]) row.expected = total(row.input);
  const sumSource = context.run(sumSpec, sumFile);
  assert.equal(sumSource.child.status, 0, JSON.stringify(sumSource.result));
  const sourceBytes = [context.file, sumFile].map(file => fs.readFileSync(file, 'utf8'));
  const target = specOf(); target.name = 'pooled-summary';
  target.routes = [[squares, '/square-total'], [total, '/total']].map(([compute, routePath]) => ({
    path: routePath, inputField: 'numbers', compute: { family: 'array-fold',
      examples: [[], [5], [-2, 6]].map(input => ({ input, expected: compute(input) })),
      acceptanceExamples: [[4, -3, 8], [7], [1, 2, 3]].map(input => ({ input, expected: compute(input) })),
    },
  }));
  target.routes.unshift({ path: '/report', inputField: 'numbers',
    compose: { squaredTotal: '/square-total', total: '/total' },
    acceptanceExamples: [[9, -1], [-5, 10, 3], [1, 3, -6]].map(input => ({ input,
      expected: { squaredTotal: squares(input), total: total(input) } })),
  });
  for (const file of [context.file, sumFile]) {
    const alone = context.run(target, file);
    assert.equal(alone.child.status, 6);
    assert.equal(alone.result.data.reason, 'PROJECT_COMPUTE_MEMORY_NO_MATCH');
    assert.deepEqual(fs.readdirSync(alone.root), []);
  }
  const pooled = context.run(target, [sumFile, context.file]);
  assert.equal(pooled.child.status, 0, JSON.stringify(pooled.result));
  assert.equal(pooled.result.data.projectMemory.sources.length, 2);
  assert.deepEqual(pooled.result.data.projectMemory.sources.map(source => source.sourceRunId), ['memory-2:c1', 'memory-1:c1']);
  assert.ok(pooled.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.equal(pooled.result.data.attempts[0].test.exitCode, 0);
  const copyFile = path.join(context.base, 'another-square-method.json');
  assert.equal(context.run(specOf(), copyFile).child.status, 0);
  const deduplicated = context.run(target, [context.file, copyFile, sumFile]);
  assert.equal(deduplicated.child.status, 0, JSON.stringify(deduplicated.result));
  assert.equal(deduplicated.result.data.projectMemory.sources.length, 3);
  assert.ok(deduplicated.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  const ambiguous = JSON.parse(JSON.stringify(target));
  for (const route of ambiguous.routes.filter(route => route.compute))
    route.compute.examples = [[], [0], [1]].map(input => ({ input, expected: total(input) }));
  const competing = context.run(ambiguous, [context.file, sumFile]);
  assert.equal(competing.child.status, 6);
  assert.equal(competing.result.data.reason, 'PROJECT_COMPUTE_MEMORY_AMBIGUOUS');
  assert.deepEqual(fs.readdirSync(competing.root), []);
  const incorrect = JSON.parse(JSON.stringify(target));
  incorrect.routes[0].acceptanceExamples[0].expected.total = 999;
  const failedAcceptance = context.run(incorrect, [context.file, sumFile]);
  assert.equal(failedAcceptance.child.status, 6);
  assert.equal(failedAcceptance.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(failedAcceptance.root), []);
  assert.deepEqual([context.file, sumFile].map(file => fs.readFileSync(file, 'utf8')), sourceBytes);
  for (const [files, reason] of [
    [[context.file, path.join(context.base, 'missing.json')], 'PROJECT_MEMORY_SOURCE_MISSING'],
    [[context.file, context.file], 'PROJECT_MEMORY_DUPLICATE_SOURCE'],
    [Array(5).fill(context.file), 'PROJECT_MEMORY_POOL_INVALID'],
  ]) {
    const refused = context.run(target, files);
    assert.equal(refused.child.status, 6);
    assert.equal(refused.result.data.reason, reason);
    assert.deepEqual(fs.readdirSync(refused.root), []);
  }
  fs.writeFileSync(sumFile, sourceBytes[1].replace('"version":1', '"version":2'));
  const corrupted = context.run(target, [context.file, sumFile]);
  assert.equal(corrupted.child.status, 6);
  assert.equal(corrupted.result.data.reason, 'PROJECT_MEMORY_INVALID');
  assert.deepEqual(fs.readdirSync(corrupted.root), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), sourceBytes[0]);
});

test('pool inputs reject nested, sparse and executable source lists before reading files', () => {
  const { loadProjectMethods } = require('../lib/coder/project-method-memory');
  let reads = 0;
  const accessor = []; Object.defineProperty(accessor, 0, { enumerable: true, get() { reads += 1; return 'method.json'; } });
  const proxy = new Proxy(['method.json'], { get() { reads += 1; throw new Error('trap'); } });
  for (const file of [[], Array(2), [['method.json']], [null], [123], accessor, proxy]) {
    assert.deepEqual(loadProjectMethods({ file }), { ok: false, reason: 'PROJECT_MEMORY_POOL_INVALID' });
  }
  assert.equal(reads, 0);
  for (const options of [undefined, null]) assert.equal(loadProjectMethods(options).ok, false);
});
