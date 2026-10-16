'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceProject } = require('../lib/coder/project-producer');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { runTask } = require('../lib/deterministic-task-runner');
const { createProjectInitializationPermission, evaluateProjectInitialization,
  verifyProjectInitialization } = require('../lib/coder/project-initialization-permission');

const specOf = () => ({ kind: 'project_spec', name: 'squares-api', archetype: 'node_computed_json_api',
  routes: [{ path: '/squares', compute: { family: 'array-fold', examples: [
    { input: [], expected: 0 }, { input: [2], expected: 4 }, { input: [3, 4], expected: 25 },
  ], acceptanceExamples: [
    { input: [-3, 8], expected: 73 }, { input: [1, 1, 1], expected: 3 }, { input: [20], expected: 400 },
  ] } }] });

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'computed-init-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source');
  const root = path.join(base, 'target');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']);
  fs.writeFileSync(path.join(sourceRoot, 'seed.txt'), 'isolated fixture');
  git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  const specFile = path.join(base, 'requirements.json');

  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') };
  delete env.NODE_TEST_CONTEXT;
  const executeArgs = (args, json = true) => {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', ...args,
      ...(json ? ['--json'] : [])], { cwd: base, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result;
    try { result = json ? JSON.parse(child.stdout) : null; }
    catch { assert.fail(child.stdout + child.stderr); }
    return { child, result };
  };
  const execute = (spec, flags = ['--initialize-project', '--source-root', sourceRoot], json = true) => {
    fs.writeFileSync(specFile, JSON.stringify(spec));
    return executeArgs(['create', specFile, '--root', root, ...flags], json);
  };
  return { root, sourceRoot, initialize: true, execute, executeArgs, base };
}

test('production CLI synthesizes squares into six files and verifies real HTTP heldouts', t => {
  const context = fixture(t);
  const { result, child } = context.execute(specOf());
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.data.outcome, 'applied_tested', JSON.stringify(result) + child.stderr);
  assert.equal(result.data.attempts[0].test.exitCode, 0);
  assert.equal(result.data.plan.files.length, 6);
  const logic = fs.readFileSync(path.join(context.root, 'src/logic.js'), 'utf8');
  assert.match(logic, /checked\((?:acc \+ checked\(item \* item\)|checked\(item \* item\) \+ acc)\)/);
  assert.equal(verifyProjectInitialization({ root: context.root, record: result.data.record }).ok, true);
  const recordFile = path.join(context.base, 'record.json');
  const baseDir = path.join(context.base, 'empty-base');
  fs.mkdirSync(baseDir);
  fs.writeFileSync(recordFile, JSON.stringify(result.data.record));
  const verifyArgs = ['verify', recordFile, '--root', context.root, '--base-dir', baseDir];
  assert.equal(context.executeArgs(verifyArgs).child.status, 0);
  fs.writeFileSync(path.join(context.root, 'src/logic.js'), logic + '\n// tampered sixth file\n');
  const tampered = verifyProjectInitialization({ root: context.root, record: result.data.record });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'HEAD_MISMATCH');
  const failedJson = context.executeArgs(verifyArgs);
  const failedText = context.executeArgs(verifyArgs, false);
  assert.equal(failedJson.child.status, 8);
  assert.equal(failedText.child.status, 8);
  assert.equal(failedJson.result.ok, false);
  assert.equal(failedJson.result.status, 'failed');
  assert.match(failedText.child.stderr, /NOT VERIFIED/);
});

test('unprojectable failures have the same human-decision exit in JSON and text', t => {
  const context = fixture(t);
  const file = path.join(context.base, 'failure.json');
  fs.writeFileSync(file, JSON.stringify({ kind: 'failure_record', schemaVersion: '1.0.0',
    failureId: 'failure-unprojectable', source: 'test_failure', verificationStatus: 'verified',
    trust: 'high', verificationReason: 'verified_by_authority',
    action: { tool: 'coder', operation: 'unknown', path: 'src/file.js', workspaceId: 'default' },
    observed: 'before', expected: 'after', evidence: [], workspaceId: 'default' }));
  const json = context.executeArgs(['propose', file]);
  const text = context.executeArgs(['propose', file], false);
  assert.equal(json.child.status, 5);
  assert.equal(text.child.status, 5);
  assert.equal(json.result.status, 'review_required');
  assert.equal(json.result.ok, false);
  assert.equal(json.result.data.task, null);
  assert.match(text.child.stderr, /NO_SUPPORTED_OPERATION/);
});

test('incorrect independent acceptance rolls back every generated file and ordinary authorization refuses', t => {
  const context = fixture(t);
  const wrong = specOf(); wrong.routes[0].compute.acceptanceExamples[0].expected = 999;
  const { result, child } = context.execute(wrong);
  assert.equal(child.status, 6);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.data.outcome, 'needs_human_decision', JSON.stringify(result));
  assert.equal(result.data.attempts[0].test.exitCode, 1);
  assert.equal(result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(context.root), []);
  const ordinary = context.execute(specOf(), ['--authorize']);
  assert.equal(ordinary.child.status, 6);
  assert.equal(ordinary.result.ok, false);
  assert.equal(ordinary.result.status, 'blocked');
  const text = context.execute(specOf(), ['--authorize'], false);
  assert.equal(text.child.status, ordinary.child.status);
  assert.match(text.child.stdout, /needs_human_decision/);
  assert.deepEqual(fs.readdirSync(context.root), []);
  assert.equal(ordinary.result.data.outcome, 'needs_human_decision');
  assert.deepEqual(fs.readdirSync(context.root), []);
  const held = applyDerivation({ task: produceProject(specOf()).task, root: context.root,
    repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false }, authorized: true });
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'GATE_REFUSED');
});

test('public project producer rejects signed zero before JSON normalization', () => {
  for (const field of ['input', 'expected']) {
    const spec = specOf();
    if (field === 'input') spec.routes[0].compute.examples[1].input = [-0];
    else spec.routes[0].compute.examples[0].expected = -0;
    assert.equal(produceProject(spec).ok, false);
  }
});

test('permission binds an immutable six-file task and cannot authorize a second application', t => {
  const context = fixture(t);
  const issued = createProjectInitializationPermission(specOf(), context);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const original = JSON.parse(JSON.stringify(issued.task));
  const gate = { decision: 'hold', reason: 'MULTI_SURFACE',
    warnings: ['Broad change spans many files.', 'Cross-cutting change across multiple surfaces detected.'],
    fileFindings: [], metadata: {} };
  const check = (task, patch) => evaluateProjectInitialization({ permission: issued.permission,
    root: context.root, task, patch, gate, fileSystem: fs });
  const logic = issued.task.operation.steps.find(step => step.path === 'src/logic.js');
  logic.content += '\n// changed after permission\n';
  assert.equal(check(issued.task, runTask(issued.task).patch), gate);
  const patch = runTask(original).patch;
  const duplicatePatch = [...patch.slice(0, -1), patch[0]];
  assert.equal(check(original, duplicatePatch), gate);
  const wrongPatch = patch.map(change => change.path === 'src/logic.js' ? { ...change, after: change.after + '\n// altered\n' } : change);
  assert.equal(check(original, wrongPatch), gate);
  const unknown = { ...gate, warnings: [...gate.warnings, 'Unexpected warning'] };
  assert.equal(evaluateProjectInitialization({ permission: issued.permission, root: context.root,
    task: original, patch, gate: unknown, fileSystem: fs }), unknown);
  assert.equal(check(original, patch).reason, 'PROJECT_INITIALIZATION_APPROVED');
  assert.equal(check(original, patch), gate);
  assert.deepEqual(fs.readdirSync(context.root), []);
});

test('a static five-file recipe does not inherit the computed broad-warning exception', t => {
  const context = fixture(t);
  const issued = createProjectInitializationPermission({ kind: 'project_spec', name: 'static-api',
    archetype: 'node_json_api', routes: [{ path: '/hello', body: { greeting: 'hello' } }] }, context);
  assert.equal(issued.ok, true);
  const gate = { decision: 'review', reason: 'MULTI_SURFACE', warnings: ['Broad change spans many files.'],
    fileFindings: [], metadata: {} };
  assert.equal(evaluateProjectInitialization({ permission: issued.permission, root: context.root,
    task: issued.task, patch: runTask(issued.task).patch, gate, fileSystem: fs }), gate);
});
