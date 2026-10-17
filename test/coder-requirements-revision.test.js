'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { runCliCoder } = require('../lib/cli-coder');
const { parseRequirements, MAX_REQUIREMENTS_BYTES } = require('../lib/coder/requirements-parser');
const { produceProject, produceProjectRevision } = require('../lib/coder/project-producer');
const { readRequirements } = require('../lib/cli-coder-requirements');
const before = 'proje durum\nGET /durum => {"ok":true}';
const after = before + '\nGET /surum => {"version":1}';
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-text-revision-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const previous = path.join(base, 'previous.txt'); const next = path.join(base, 'next.txt');
  fs.writeFileSync(previous, before); fs.writeFileSync(next, after);
  return { base, previous, next };
}
const options = () => ({ json: true, coderLoop: { produceProjectRevision,
  readProjectRequirements: file => readRequirements(file, { parseRequirements, maxBytes: MAX_REQUIREMENTS_BYTES }) } });

test('text revision previews the existing additive and explicit update plans without writing', t => {
  const { base, previous, next } = fixture(t);
  const args = ['revise', next, '--requirements-text', '--previous-requirements', previous, '--dry-run', '--root', base];
  const planned = runCliCoder(args, options());
  assert.equal(planned.status, 'proposed');
  assert.deepEqual(planned.data, produceProjectRevision({ kind: 'project_revision',
    previous: parseRequirements(before).spec, next: parseRequirements(after).spec }));
  const changed = after.replace('true', 'false'); fs.writeFileSync(next, changed);
  assert.equal(runCliCoder(args, options()).data.reason, 'PROJECT_REVISION_CONTRACT_CHANGED');
  const update = runCliCoder([...args, '--update-routes'], options());
  assert.equal(update.status, 'proposed');
  assert.deepEqual(update.data, produceProjectRevision({ kind: 'project_revision',
    previous: parseRequirements(before).spec, next: parseRequirements(changed).spec, mode: 'update_routes' }));
  assert.deepEqual(fs.readdirSync(base).sort(), ['next.txt', 'previous.txt']);
});

test('text revision refuses missing baselines and misplaced flags before reading inputs', t => {
  const { previous, next } = fixture(t);
  const run = args => runCliCoder(args, options());
  assert.throws(() => run(['revise', next, '--requirements-text']), /requires --previous-requirements/);
  for (const command of ['create', 'verify', 'propose', 'remember']) {
    assert.throws(() => run([command, 'absent', '--previous-requirements', previous]), /require coder revise --requirements-text/);
    assert.throws(() => run([command, 'absent', '--update-routes']), /require coder revise --requirements-text/);
  }
  assert.throws(() => run(['revise', next, '--previous-requirements', previous]), /require coder revise --requirements-text/);
  assert.throws(() => run(['revise', next, '--requirements-text', '--previous-requirements', 'absent']), /REQUIREMENTS_FILE_UNAVAILABLE/);
  fs.writeFileSync(previous, 'proje eksik');
  assert.throws(() => run(['revise', next, '--requirements-text', '--previous-requirements', previous]), /REQUIREMENTS_INCOMPLETE/);
});

test('native text revisions retain old tests, gate authorization and roll back a vetoed update', t => {
  const { base, previous, next } = fixture(t); const root = path.join(base, 'repo'); fs.mkdirSync(root);
  const generated = produceProject(parseRequirements(before).spec);
  for (const step of generated.task.operation.steps) {
    const file = path.join(root, step.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, step.content);
  }
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']);
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']); };
  commit();
  // Both requirement files can live untracked inside the repository, as the JSON task can.
  const localPrevious = path.join(root, 'previous.txt'); const localNext = path.join(root, 'next.txt');
  fs.copyFileSync(previous, localPrevious); fs.copyFileSync(next, localNext);
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  const run = extra => {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'revise', localNext,
      '--requirements-text', '--previous-requirements', localPrevious, '--root', root, '--json', ...extra],
    { cwd: base, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result };
  };
  const original = fs.readFileSync(path.join(root, 'routes.json'), 'utf8');
  const held = run([]); assert.equal(held.child.status, 6, JSON.stringify(held.result));
  assert.equal(fs.readFileSync(path.join(root, 'routes.json'), 'utf8'), original);
  const added = run(['--authorize']); assert.equal(added.child.status, 0, JSON.stringify(added.result));
  assert.equal(added.result.data.outcome, 'applied_tested');
  fs.rmSync(localPrevious); fs.rmSync(localNext); commit();
  const saved = new Map(generated.task.operation.steps.map(step => [step.path, fs.readFileSync(path.join(root, step.path), 'utf8')]));
  // This authored regression test is independent of the regenerated HTTP acceptance suite.
  fs.writeFileSync(path.join(root, 'test/client.test.js'), 'const assert=require("node:assert/strict");const routes=require("../routes.json");assert.ok(JSON.stringify(routes).includes("true"));');
  commit();
  fs.writeFileSync(localPrevious, after); fs.writeFileSync(localNext, after.replace('true', 'false'));
  const vetoed = run(['--authorize', '--update-routes']);
  assert.equal(vetoed.child.status, 6, JSON.stringify(vetoed.result));
  assert.equal(vetoed.result.data.attempts[0].test.exitCode, 1);
  assert.equal(vetoed.result.data.attempts[0].rolledBack, true);
  for (const [file, content] of saved) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), content);
  assert.match(fs.readFileSync(path.join(root, 'test/client.test.js'), 'utf8'), /includes/);
  assert.equal(git(['diff', '--exit-code']).toString(), '');
  fs.rmSync(localPrevious); fs.rmSync(localNext);
  fs.rmSync(path.join(root, 'test/client.test.js')); commit();
  fs.writeFileSync(localPrevious, after); fs.writeFileSync(localNext, after.replace('true', 'false'));
  const updated = run(['--authorize', '--update-routes']);
  assert.equal(updated.child.status, 0, JSON.stringify(updated.result));
  assert.equal(updated.result.data.outcome, 'applied_tested');
  assert.equal(updated.result.data.attempts[0].test.exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'routes.json'), 'utf8'))[0].body.ok, false);
});
