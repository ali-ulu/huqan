'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceProject, produceProjectRevision } = require('../lib/coder/project-producer');
const previous = { kind: 'project_spec', name: 'growing-api', archetype: 'node_json_api',
  routes: [{ path: '/hello', body: { message: 'hello' } }] };
const revision = () => ({ kind: 'project_revision', previous: structuredClone(previous),
  next: { ...structuredClone(previous), routes: [...structuredClone(previous.routes), { path: '/health', body: { ok: true } }] } });
function computedRevision() {
  const row = (input, expected) => ({ input, expected });
  const initial = { kind: 'project_spec', name: 'growing-computation', archetype: 'node_computed_json_api', routes: [{
    path: '/sum', compute: { family: 'array-fold', examples: [row([], 0), row([1, 2], 3), row([-3, 5], 2)],
      acceptanceExamples: [row([8, 2], 10), row([-7, 3], -4), row([4], 4)] }
  }] };
  return { kind: 'project_revision', previous: initial, next: { ...structuredClone(initial), routes: [...structuredClone(initial.routes), {
    path: '/max', compute: { family: 'array-stateful-fold',
      examples: [row([], 0), row([2, 5], 5), row([5, 2], 5), row([-4, -2], -2), row([-2, 7, 1], 7)],
      acceptanceExamples: [row([6, 9], 9), row([-8, -3], -3), row([22], 22)] }
  }] } };
}

test('plans additive revisions with exact baseline replacements and the complete test suite', () => {
  const result = produceProjectRevision(revision());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.task.test.command, 'node --test');
  assert.ok(result.task.operation.steps.every(step => step.type === 'replace_text'));
  const baseline = produceProject(previous).task.operation.steps;
  for (const step of result.task.operation.steps)
    assert.equal(step.find, baseline.find(original => original.path === step.path).content);
  assert.deepEqual(result.task.allowedPaths, result.task.operation.steps.map(step => step.path));
  const changed = revision(); changed.next.routes[0].body.message = 'changed';
  assert.equal(produceProjectRevision(changed).reason, 'PROJECT_REVISION_CONTRACT_CHANGED');
  const renamed = revision(); renamed.next.name = 'renamed-api';
  assert.equal(produceProjectRevision(renamed).reason, 'PROJECT_REVISION_CONTRACT_CHANGED');
  const unchanged = revision(); unchanged.next = structuredClone(previous);
  assert.equal(produceProjectRevision(unchanged).reason, 'PROJECT_REVISION_NO_ADDITION');
  let calls = 0;
  assert.equal(produceProjectRevision({ get kind() { calls += 1; return 'project_revision'; } }).reason, 'PROJECT_REVISION_INVALID');
  assert.equal(calls, 0);
});

test('native CLI extends an existing repository, preserves sidecars and rolls back failed old tests', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-revise-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const mode of ['success', 'computed-success', 'failed-old-test', 'drift', 'unauthorized']) {
    const requested = mode === 'computed-success' ? computedRevision() : revision();
    const baseline = produceProject(requested.previous);
    assert.equal(baseline.ok, true, baseline.reason);
    const root = path.join(base, mode); fs.mkdirSync(root);
    for (const step of baseline.task.operation.steps) {
      const file = path.join(root, step.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, step.content);
    }
    fs.writeFileSync(path.join(root, 'notes.txt'), 'keep');
    fs.writeFileSync(path.join(root, 'test', 'sidecar.test.js'),
      `const assert = require('node:assert/strict'); const fs = require('node:fs'); assert.equal(fs.readFileSync('notes.txt', 'utf8'), '${mode === 'failed-old-test' ? 'different' : 'keep'}');`);
    if (mode === 'drift') fs.appendFileSync(path.join(root, 'test', 'api.test.js'), '\n// authored test customization\n');
    const original = new Map(baseline.task.operation.steps.map(step => [step.path, fs.readFileSync(path.join(root, step.path), 'utf8')]));
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    git(['init', '-b', 'codex/revision']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline']);
    const specFile = path.join(base, `${mode}.json`); fs.writeFileSync(specFile, JSON.stringify(requested));
    const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'revise', specFile,
      '--root', root, ...(mode === 'unauthorized' ? [] : ['--authorize']), '--journal', path.join(base, `${mode}.db`), '--json'],
    { cwd: base, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    const result = JSON.parse(child.stdout);
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'keep');
    if (mode === 'success' || mode === 'computed-success') {
      assert.equal(child.status, 0, JSON.stringify(result));
      assert.equal(result.data.attempts[0].test.exitCode, 0);
      assert.equal(result.data.record.observedVerification.ok, true);
      assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'routes.json'), 'utf8')).some(route => route.path === requested.next.routes.at(-1).path));
    } else {
      assert.equal(child.status, 6, JSON.stringify(result));
      for (const [file, text] of original) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), text);
      if (mode === 'failed-old-test') assert.equal(result.data.attempts[0].rolledBack, true);
    }
  }
});
