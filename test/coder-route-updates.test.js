'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceProject, produceProjectRevision } = require('../lib/coder/project-producer');

function request() {
  const previous = { kind: 'project_spec', name: 'changing-api', archetype: 'node_json_api', routes: [
    { path: '/hello', body: { message: 'hello' } }, { path: '/health', body: { ok: true } }] };
  const next = structuredClone(previous); next.routes[0].body.message = 'updated';
  return { kind: 'project_revision', mode: 'update_routes', previous, next };
}

test('explicit route updates bind the old contents and preserve additive defaults and route identities', () => {
  const spec = request();
  const updated = produceProjectRevision(spec);
  assert.equal(updated.ok, true, updated.reason);
  assert.ok(updated.task.expectedPatch.every(change => change.before !== change.after));
  assert.ok(updated.task.operation.steps.every(step => step.type === 'replace_text'));
  assert.equal(updated.plan.revisionMode, 'update_routes');
  const implicit = structuredClone(spec); delete implicit.mode;
  assert.equal(produceProjectRevision(implicit).reason, 'PROJECT_REVISION_CONTRACT_CHANGED');
  for (const mode of ['replace_all', null, false]) {
    const invalid = request(); invalid.mode = mode;
    assert.equal(produceProjectRevision(invalid).reason, 'PROJECT_REVISION_INVALID');
  }
  const unchanged = request(); unchanged.next = structuredClone(unchanged.previous);
  assert.equal(produceProjectRevision(unchanged).reason, 'PROJECT_REVISION_NO_CHANGE');
  for (const change of [value => value.next.routes.pop(), value => value.next.routes.reverse(),
    value => { value.next.routes[0].path = '/renamed'; }, value => { value.next.name = 'renamed-api'; }]) {
    const invalid = request(); change(invalid);
    assert.equal(produceProjectRevision(invalid).reason, 'PROJECT_REVISION_CONTRACT_CHANGED');
  }
});

test('native route update uses learned methods, preserves old-test veto and transfers its sealed record', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-route-update-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const commit = root => {
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    git(['init', '-b', 'codex/fixture']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  };
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture'); commit(source);
  const journal = path.join(base, 'journal.db'), memory = path.join(base, 'bank.json');
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  let sequence = 0;
  const run = (mode, spec, root, flags) => {
    const id = `update-${++sequence}`, file = path.join(base, `${id}.json`); fs.writeFileSync(file, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', mode, file,
      '--root', root, '--journal', journal, '--run-id', id, '--json', ...flags],
    { cwd: base, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result };
  };
  const row = (input, expected) => ({ input, expected });
  const sum = { family: 'array-fold', examples: [row([], 0), row([1, 2], 3), row([-3, 5], 2)],
    acceptanceExamples: [row([8, 2], 10), row([-7, 3], -4), row([4], 4)] };
  const max = { family: 'array-stateful-fold', examples: [row([], 0), row([2, 5], 5), row([5, 2], 5), row([-4, -2], -2), row([-2, 7, 1], 7)],
    acceptanceExamples: [row([6, 9], 9), row([-8, -3], -3), row([22], 22)] };
  const bank = { kind: 'project_spec', name: 'route-bank', archetype: 'node_computed_json_api',
    routes: [{ path: '/sum', compute: sum }, { path: '/max', compute: max }] };
  const teacher = path.join(base, 'teacher'); fs.mkdirSync(teacher);
  const taught = run('create', bank, teacher, ['--initialize-project', '--source-root', source, '--project-memory', memory]);
  assert.equal(taught.child.status, 0, JSON.stringify(taught.result));
  const memoryBytes = fs.readFileSync(memory, 'utf8');
  const previous = { ...bank, name: 'updating-api', routes: [{ path: '/measure', compute: sum }] };
  const next = { ...structuredClone(previous), routes: [{ path: '/measure', compute: {
    family: 'array-stateful-fold', examples: [row([], 0), row([3, 8], 8), row([8, 3], 8), row([-8, -1], -1)],
    acceptanceExamples: [row([9, 2], 9), row([-7, -6], -6), row([30], 30)] } }] };
  const learned = path.join(base, 'updated-method.json');
  for (const mode of ['success', 'old-test-conflict', 'drift', 'unauthorized', 'missing-mode']) {
    const root = path.join(base, mode); fs.mkdirSync(root);
    const baseline = produceProject(previous); assert.equal(baseline.ok, true, baseline.reason);
    for (const step of baseline.task.operation.steps) {
      const file = path.join(root, step.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, step.content);
    }
    fs.writeFileSync(path.join(root, 'notes.txt'), 'keep');
    if (mode === 'drift') fs.appendFileSync(path.join(root, 'src', 'logic.js'), '\n// custom implementation\n');
    if (mode === 'old-test-conflict') fs.writeFileSync(path.join(root, 'test', 'client.test.js'),
      `const {test}=require('node:test'); const assert=require('node:assert/strict'); const {createServer}=require('../src/server');
test('old client contract',async t=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
const response=await fetch('http://127.0.0.1:'+server.address().port+'/measure',{method:'POST',body:'[1,2]'});
assert.deepEqual(await response.json(),{result:3});});`);
    commit(root);
    const originals = baseline.task.operation.steps.map(step => [step.path, fs.readFileSync(path.join(root, step.path), 'utf8')]);
    const output = mode === 'success' ? learned : path.join(base, `${mode}-method.json`);
    const revision = { kind: 'project_revision', ...(mode === 'missing-mode' ? {} : { mode: 'update_routes' }), previous, next };
    const updated = run('revise', revision, root, ['--project-memory', memory, '--project-memory-out', output,
      ...(mode === 'unauthorized' ? [] : ['--authorize'])]);
    assert.equal(updated.child.status, mode === 'success' ? 0 : 6, JSON.stringify(updated.result));
    if (mode === 'success') {
      assert.equal(updated.result.data.plan.computation.routes[0].source, 'memory');
      assert.equal(updated.result.data.plan.computation.routes[0].enumerated, 0);
      assert.equal(updated.result.data.projectMemory.state, 'remembered');
      assert.equal(updated.result.data.attempts[0].test.exitCode, 0);
    } else {
      assert.equal(fs.existsSync(output), false);
      for (const [file, content] of originals) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), content);
      if (mode === 'old-test-conflict') assert.equal(updated.result.data.attempts[0].rolledBack, true);
      if (mode === 'missing-mode') assert.equal(updated.result.data.reason, 'PROJECT_REVISION_CONTRACT_CHANGED');
    }
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(memory, 'utf8'), memoryBytes);
  }
  const transfer = path.join(base, 'transfer'); fs.mkdirSync(transfer);
  const target = { ...structuredClone(next), name: 'transferred-update' };
  target.routes[0].path = '/largest';
  target.routes[0].compute.examples = [row([], 0), row([4, 10], 10), row([10, 4], 10), row([-9, -5], -5)];
  target.routes[0].compute.acceptanceExamples = [row([11, 3], 11), row([-12, -4], -4), row([40], 40)];
  const reused = run('create', target, transfer, ['--initialize-project', '--source-root', source, '--project-memory', learned]);
  assert.equal(reused.child.status, 0, JSON.stringify(reused.result));
  assert.equal(reused.result.data.plan.computation.routes[0].enumerated, 0);
});
