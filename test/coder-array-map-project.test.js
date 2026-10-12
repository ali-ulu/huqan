'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceProject } = require('../lib/coder/project-producer');
const specOf = () => ({ kind: 'project_spec', name: 'mapped-api', archetype: 'node_computed_json_api', routes: [
  { path: '/squares', compute: { family: 'array-map', examples: [
    { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [3, 4], expected: [9, 16] },
  ], acceptanceExamples: [
    { input: [-3, 8], expected: [9, 64] }, { input: [1, 1, 1], expected: [1, 1, 1] }, { input: [20], expected: [400] },
  ] } },
] });

test('array results are inferred from training only and warm reuse does not enumerate', () => {
  const cold = produceProject(specOf()); assert.equal(cold.ok, true, JSON.stringify(cold));
  assert.equal(cold.plan.computation.routes[0].enumerated, 4105);
  const target = specOf(); target.routes[0].compute.acceptanceExamples[0].expected = [999, 999];
  const warm = produceProject(target, { candidatePrograms: [cold.plan.computation.routes[0].program] });
  assert.equal(warm.ok, true, JSON.stringify(warm));
  assert.equal(warm.plan.computation.routes[0].enumerated, 0);
  assert.equal(warm.task.operation.steps.find(step => step.path === 'src/logic.js').content,
    cold.task.operation.steps.find(step => step.path === 'src/logic.js').content);
  for (const expected of [[4, 4], [-0], [1000001], 4]) {
    const invalid = specOf(); invalid.routes[0].compute.examples[1].expected = expected;
    assert.equal(produceProject(invalid).ok, false);
  }
});

test('generated HTTP map service rejects overflowing intermediates and signed-zero results', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-http-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = specOf();
  for (const group of ['examples', 'acceptanceExamples'])
    for (const row of spec.routes[0].compute[group]) row.expected = row.input.map(value => value * value * value);
  const modulo = JSON.parse(JSON.stringify(spec.routes[0])); modulo.path = '/remainder';
  modulo.compute.examples = [[], [1], [2, 3]].map(input => ({ input, expected: input.map(value => value % 2) }));
  modulo.compute.acceptanceExamples = [[5], [4, 6], [7, 8]].map(input => ({ input, expected: input.map(value => value % 2) }));
  spec.routes.push(modulo);
  const produced = produceProject(spec); assert.equal(produced.ok, true, JSON.stringify(produced));
  for (const step of produced.task.operation.steps) {
    const file = path.join(root, step.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, step.content);
  }
  const server = require(path.join(root, 'src/server')).createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = (route, values) => fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST', body: JSON.stringify(values) });
  const good = await post('/squares', [2, -3]); assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { result: [8, -27] });
  assert.equal((await post('/squares', [1000000])).status, 422);
  assert.equal((await post('/remainder', [-4])).status, 422);
});

test('native CLI learns mixed map and fold methods, reuses array results and rolls back bad composed acceptance', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'array-map-project-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'); fs.mkdirSync(sourceRoot);
  const git = args => execFileSync('git', args, { cwd: sourceRoot, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/map-fixture']); fs.writeFileSync(path.join(sourceRoot, 'seed.txt'), 'fixture'); git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const memory = path.join(base, 'method.json'); let sequence = 0;
  const run = spec => {
    sequence += 1; const root = path.join(base, `target-${sequence}`); fs.mkdirSync(root);
    const file = path.join(base, `spec-${sequence}.json`); fs.writeFileSync(file, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', file,
      '--root', root, '--initialize-project', '--source-root', sourceRoot, '--journal', path.join(base, 'journal.db'),
      '--project-memory', memory, '--run-id', `map-${sequence}`, '--json'], { cwd: base, encoding: 'utf8',
      timeout: 60000, windowsHide: true, env: { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') } });
    assert.equal(child.error, undefined, String(child.error));
    return { child, root, result: JSON.parse(child.stdout) };
  };
  const spec = specOf();
  const sum = JSON.parse(JSON.stringify(spec.routes[0])); sum.path = '/total'; sum.compute.family = 'array-fold';
  for (const group of ['examples', 'acceptanceExamples'])
    for (const row of sum.compute[group]) row.expected = row.input.reduce((acc, item) => acc + item, 0);
  spec.routes.push(sum);
  spec.routes.unshift({ path: '/report', compose: { squares: '/squares', total: '/total' }, acceptanceExamples: [
    { input: [4, -2], expected: { squares: [16, 4], total: 2 } },
    { input: [5], expected: { squares: [25], total: 5 } },
    { input: [1, 2], expected: { squares: [1, 4], total: 3 } },
  ] });
  const cold = run(spec); assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  assert.deepEqual(cold.result.data.plan.computation.routes.map(route => route.enumerated), [4105, 7062]);
  const bytes = fs.readFileSync(memory, 'utf8');
  const target = JSON.parse(JSON.stringify(spec)); target.name = 'mapped-transfer';
  for (const route of target.routes) route.inputField = 'numbers';
  target.routes[0].path = '/new-report'; target.routes[0].compose = { squares: '/new-squares', total: '/new-total' };
  target.routes[1].path = '/new-squares'; target.routes[2].path = '/new-total';
  for (const route of target.routes.filter(route => route.compute)) {
    const compute = input => route.compute.family === 'array-map' ? input.map(item => item * item) : input.reduce((acc, item) => acc + item, 0);
    route.compute.examples = [[], [6], [-2, 7]].map(input => ({ input, expected: compute(input) }));
    route.compute.acceptanceExamples = [[8, -3], [9], [1, 2, 3]].map(input => ({ input, expected: compute(input) }));
  }
  const warm = run(target); assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.ok(warm.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  target.routes[0].acceptanceExamples[0].expected.squares[0] = 999;
  const bad = run(target); assert.equal(bad.child.status, 6, JSON.stringify(bad.result));
  assert.equal(bad.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(bad.root), []);
  assert.equal(fs.readFileSync(memory, 'utf8'), bytes);
});
