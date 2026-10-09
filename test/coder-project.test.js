'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { produceProject } = require('../lib/coder/project-producer');
const { runFixLoop } = require('../lib/coder/fix-loop');
const { runCliCoder } = require('../lib/cli-coder');
const { verifyDerivation, directoryReader } = require('../lib/coder/verify-derivation');
const { initializeProject } = require('../lib/coder/project-initialization');

const SPEC = { kind: 'project_spec', name: 'greeting-api', archetype: 'node_json_api',
  routes: [{ path: '/hello', body: { greeting: 'Merhaba' } }] };
const REPO = { branch: 'codex/project', dirty: false, hasUntracked: false };

function rootOf(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-project-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function initializationContext(t) {
  const base = rootOf(t);
  const sourceRoot = path.join(base, 'source');
  const root = path.join(base, 'target');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(root);
  const git = args => require('node:child_process').execFileSync('git', args, {
    cwd: sourceRoot, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-b', 'codex/fixture']);
  fs.writeFileSync(path.join(sourceRoot, 'seed.txt'), 'isolated fixture');
  git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Initial fixture']);
  return { root, sourceRoot, initialize: true, git };
}

test('requirements deterministically produce a reviewed plan and a multi-file task', () => {
  const first = produceProject(SPEC);
  assert.deepEqual(first, produceProject(JSON.parse(JSON.stringify(SPEC))));
  assert.equal(first.ok, true);
  assert.equal(first.task.operation.type, 'sequence');
  assert.equal(first.task.operation.steps.length, 5);
  assert.equal(first.task.test.command, 'node --test test/api.test.js');
  assert.equal(first.plan.requirements.length, 1);
});

test('unknown requirements are refused rather than silently omitted', () => {
  for (const spec of [{ ...SPEC, authentication: true }, { ...SPEC, archetype: 'unknown' },
    { ...SPEC, routes: [{ path: '/hello', body: {}, method: 'POST' }] },
    { ...SPEC, routes: Array(9).fill(SPEC.routes[0]) }]) {
    const result = produceProject(spec);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'needs_human_decision');
    assert.equal(result.task, null);
  }
});

test('executable properties are rejected without invoking getters or toJSON', () => {
  let calls = 0;
  const spec = { ...SPEC };
  Object.defineProperty(spec, 'toJSON', { value: () => { calls++; return SPEC; } });
  assert.equal(produceProject(spec).ok, false);
  const getter = { ...SPEC };
  Object.defineProperty(getter, 'name', { enumerable: true, get() { calls++; return SPEC.name; } });
  assert.equal(produceProject(getter).ok, false);
  const routes = [...SPEC.routes];
  Object.setPrototypeOf(routes, Object.create(Array.prototype, {
    toJSON: { value() { calls++; return []; } },
  }));
  assert.equal(produceProject({ ...SPEC, routes }).ok, false);
  assert.equal(calls, 0);
});

test('Proxy traps and non-JSON array properties are refused before execution or omission', () => {
  let traps = 0;
  const proxy = new Proxy(SPEC, {
    getPrototypeOf() { traps++; return Object.prototype; },
    ownKeys() { traps++; return Reflect.ownKeys(SPEC); },
  });
  assert.equal(produceProject(proxy).ok, false);
  const nested = { ...SPEC, routes: [{ path: '/hello', body: proxy }] };
  assert.equal(produceProject(nested).ok, false);
  assert.equal(traps, 0);
  const routes = [...SPEC.routes];
  routes.extraRequirement = true;
  assert.equal(produceProject({ ...SPEC, routes }).ok, false);
});

test('generated request handler returns 400 for an invalid URL', () => {
  let handler;
  const source = produceProject(SPEC).task.operation.steps.find(step => step.path === 'src/server.js').content;
  const sandbox = { URL, module: { exports: {} }, require(id) {
    if (id === 'node:http') return { createServer(callback) { handler = callback; return {}; } };
    if (id === '../routes.json') return SPEC.routes;
    throw new Error(id);
  } };
  require('node:vm').runInNewContext(source, sandbox);
  sandbox.module.exports.createServer();
  let status;
  let ended = false;
  assert.doesNotThrow(() => handler({ url: 'http://[', method: 'GET' }, {
    writeHead(value) { status = value; }, end() { ended = true; },
  }));
  assert.equal(status, 400);
  assert.equal(ended, true);
});

test('isolated recipe fixture passes real HTTP tests and detects output mutation without gate authorization', (t) => {
  const root = rootOf(t);
  const task = produceProject(SPEC).task;
  const held = runFixLoop({ task, root, repoState: REPO, authorized: true });
  assert.equal(held.ok, false);
  const refused = require('../lib/coder/apply-derivation').applyDerivation({
    task, root, repoState: REPO, authorized: true,
  });
  assert.equal(refused.ok, false);
  assert.deepEqual(fs.readdirSync(root), []);
  // Fixture materialization tests recipe correctness, not permission to apply it.
  const derived = require('../lib/deterministic-task-runner').runTask(task);
  assert.equal(derived.status, 'COMPLETED');
  for (const change of derived.patch) {
    const target = path.join(root, change.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, change.after);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const execute = () => require('node:child_process').spawnSync(process.execPath,
    ['--test', 'test/api.test.js'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  const passed = execute();
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  const record = refused.record;
  const verified = verifyDerivation({ record, readBase: () => null, readHead: directoryReader(root) });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  fs.writeFileSync(path.join(root, 'routes.json'), JSON.stringify([{ path: '/hello', body: { greeting: 'wrong' } }]));
  const failed = execute();
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /ERR_ASSERTION/u);
  const changed = verifyDerivation({ record, readBase: () => null, readHead: directoryReader(root) });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'HEAD_MISMATCH');
});

test('blank project becomes a tested service and its derivation independently re-verifies', (t) => {
  const context = initializationContext(t);
  const { root } = context;
  const result = initializeProject(SPEC, context);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.attempts[0].test.exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'src/server.js')), true);
  const verified = verifyDerivation({ record: result.record, readBase: () => null, readHead: directoryReader(root) });
  assert.equal(verified.ok, true, JSON.stringify(verified));
});

test('CLI project preview writes nothing and production composition can execute it', (t) => {
  const { root, sourceRoot } = initializationContext(t);
  const specFile = path.join(path.dirname(root), 'requirements.json');
  fs.writeFileSync(specFile, JSON.stringify(SPEC));
  const coderLoop = { ...require('../lib/coder/fix-loop'), produceProject };
  const preview = runCliCoder(['create', specFile, '--root', root, '--dry-run'], { json: true, coderLoop });
  assert.equal(preview.status, 'proposed');
  assert.equal(fs.existsSync(path.join(root, 'src')), false);
  const { createCliCommandHandlers } = require('../lib/coder/cli-composition');
  const handlers = createCliCommandHandlers({});
  const held = handlers.coder(null, ['create', specFile, '--root', root, '--authorize'], { json: true });
  assert.equal(held.status, 'refused');
  assert.deepEqual(fs.readdirSync(root), []);
  const result = handlers.coder(null, ['create', specFile, '--root', root,
    '--initialize-project', '--source-root', sourceRoot], { json: true });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.data.plan.archetype, 'node_json_api');
});

test('initialization defaults closed and refuses dirty or main sources', (t) => {
  const context = initializationContext(t);
  assert.equal(initializeProject(SPEC, { ...context, initialize: false }).reason, 'PROJECT_INITIALIZATION_NOT_APPROVED');
  fs.writeFileSync(path.join(context.sourceRoot, 'untracked.txt'), 'dirty');
  assert.equal(initializeProject(SPEC, context).reason, 'PROJECT_SOURCE_DIRTY');
  fs.unlinkSync(path.join(context.sourceRoot, 'untracked.txt'));
  context.git(['branch', '-m', 'main']);
  assert.equal(initializeProject(SPEC, context).reason, 'PROJECT_SOURCE_BRANCH_REFUSED');
  assert.deepEqual(fs.readdirSync(context.root), []);
});

test('a zero-exit test with mutated output fails independent verification and rolls back empty', (t) => {
  const context = initializationContext(t);
  const journal = require('../lib/experience/journal').createExperienceJournal();
  const original = fs.readFileSync;
  let mutated = false;
  fs.readFileSync = function(target, ...args) {
    if (String(target) === path.join(context.root, 'routes.json') && fs.existsSync(target) && !mutated) {
      mutated = true;
      fs.writeFileSync(target, '[]');
    }
    return original.call(this, target, ...args);
  };
  let result;
  try { result = initializeProject(SPEC, { ...context, journal, runId: 'project-mutated' }); }
  finally { fs.readFileSync = original; }
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0].test.reason, 'HEAD_MISMATCH');
  assert.equal(result.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(context.root), []);
  const closed = journal.read('project-mutated:c1').find(event => event.type === 'run_closed');
  assert.notEqual(closed.outcomeStatus, 'verified');
  assert.equal(closed.payload.evidence.kept, false);
});

test('task metadata and forged permission cannot authorize an ordinary protected task', (t) => {
  const root = rootOf(t);
  const task = { ...produceProject(SPEC).task, projectInitialization: true,
    recipeVersion: '1', operatorAuthorized: true };
  const result = require('../lib/coder/apply-derivation').applyDerivation({ task, root,
    repoState: REPO, authorized: true, projectInitializationPermission: Object.freeze({}) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'GATE_REFUSED');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('initialization refuses existing targets, source overlap and symbolic links', (t) => {
  const context = initializationContext(t);
  fs.writeFileSync(path.join(context.root, 'existing.txt'), 'preserve');
  assert.equal(initializeProject(SPEC, context).reason, 'PROJECT_TARGET_NOT_EMPTY');
  assert.equal(fs.readFileSync(path.join(context.root, 'existing.txt'), 'utf8'), 'preserve');
  assert.equal(initializeProject(SPEC, { ...context, root: context.sourceRoot }).reason, 'PROJECT_TARGET_OVERLAPS_SOURCE');
  const link = path.join(path.dirname(context.root), 'linked-target');
  fs.symlinkSync(context.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(initializeProject(SPEC, { ...context, root: link }).reason, 'PROJECT_TARGET_LINK_OR_INVALID');
});

test('unexpected files fail completion and a nonempty rollback is reported without deleting them', (t) => {
  const context = initializationContext(t);
  const journal = require('../lib/experience/journal').createExperienceJournal();
  const original = fs.writeFileSync;
  fs.writeFileSync = function(target, ...args) {
    const result = original.call(this, target, ...args);
    if (String(target) === path.join(context.root, 'README.md')) original.call(this,
      path.join(context.root, 'unexpected.txt'), 'preserve external file');
    return result;
  };
  let result;
  try { result = initializeProject(SPEC, { ...context, journal, runId: 'project-extra' }); }
  finally { fs.writeFileSync = original; }
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ROLLBACK_NOT_VERIFIED');
  assert.equal(result.attempts[0].test.reason, 'PROJECT_OUTPUT_UNEXPECTED');
  assert.equal(result.attempts[0].rolledBack, false);
  assert.deepEqual(fs.readdirSync(context.root), ['unexpected.txt']);
  const closed = journal.read('project-extra:c1').find(event => event.type === 'run_closed');
  assert.notEqual(closed.outcomeStatus, 'verified');
  assert.equal(closed.payload.evidence.kept, false);
});

test('direct permission use cannot skip fixed verification with null or forged verifier', (t) => {
  for (const fakeVerifier of [null, () => ({ ok: true })]) {
    const context = initializationContext(t);
    const issued = require('../lib/coder/project-initialization-permission')
      .createProjectInitializationPermission(SPEC, context);
    assert.equal(issued.ok, true);
    const original = fs.writeFileSync;
    fs.writeFileSync = function(target, ...args) {
      const value = original.call(this, target, ...args);
      if (String(target) === path.join(context.root, 'README.md')) original.call(this,
        path.join(context.root, 'routes.json'), '[]');
      return value;
    };
    let result;
    try { result = require('../lib/coder/apply-derivation').applyDerivation({ task: issued.task,
      root: context.root, repoState: issued.repoState, projectInitializationPermission: issued.permission,
      verify: fakeVerifier }); }
    finally { fs.writeFileSync = original; }
    assert.equal(result.ok, false);
    assert.equal(result.record.observedVerification.ran, true);
    assert.equal(result.initializationVerification.test.exitCode, 1);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(fs.readdirSync(context.root), []);
  }
});

test('exclusive-create collision preserves the outside file and reports incomplete rollback', (t) => {
  const context = initializationContext(t);
  const original = fs.writeFileSync;
  let collided = false;
  fs.writeFileSync = function(target, ...args) {
    if (!collided && String(target) === path.join(context.root, 'routes.json') && args[1]?.flag === 'wx') {
      collided = true;
      original.call(this, target, 'outside concurrent file');
    }
    return original.call(this, target, ...args);
  };
  let result;
  try { result = initializeProject(SPEC, context); }
  finally { fs.writeFileSync = original; }
  assert.equal(collided, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ROLLBACK_NOT_VERIFIED');
  assert.deepEqual(fs.readdirSync(context.root), ['routes.json']);
  assert.equal(fs.readFileSync(path.join(context.root, 'routes.json'), 'utf8'), 'outside concurrent file');
});

test('permission binds exact command, native filesystem and live clean source', (t) => {
  for (const mutation of ['command', 'filesystem', 'source']) {
    const context = initializationContext(t);
    const issued = require('../lib/coder/project-initialization-permission')
      .createProjectInitializationPermission(SPEC, context);
    assert.equal(issued.ok, true);
    if (mutation === 'command') issued.task.test.command = 'node arbitrary.js';
    if (mutation === 'source') fs.writeFileSync(path.join(context.sourceRoot, 'dirty.txt'), 'source changed');
    const result = require('../lib/coder/apply-derivation').applyDerivation({ task: issued.task,
      root: context.root, repoState: issued.repoState, projectInitializationPermission: issued.permission,
      ...(mutation === 'filesystem' ? { fs: { ...fs } } : {}) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'GATE_REFUSED');
    assert.deepEqual(fs.readdirSync(context.root), []);
  }
});

test('a replaced target root fails closed without rolling back files through a junction', (t) => {
  const context = initializationContext(t);
  const outside = path.join(path.dirname(context.root), 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve');
  const original = fs.writeFileSync;
  fs.writeFileSync = function(target, ...args) {
    const value = original.call(this, target, ...args);
    if (String(target) === path.join(context.root, 'README.md')) {
      fs.renameSync(context.root, context.root + '-original');
      fs.symlinkSync(outside, context.root, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return value;
  };
  let result;
  try { result = initializeProject(SPEC, context); }
  finally { fs.writeFileSync = original; }
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ROLLBACK_NOT_VERIFIED');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'preserve');
});

test('an existing project file is preserved and a main branch refuses generation', (t) => {
  const root = rootOf(t);
  const produced = produceProject(SPEC);
  const blocked = runFixLoop({ task: produced.task, root, repoState: { ...REPO, branch: 'main' }, authorized: true });
  assert.equal(blocked.ok, false);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.writeFileSync(path.join(root, 'package.json'), 'existing');
  const result = runFixLoop({ task: produced.task, root, repoState: REPO, authorized: true });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), 'existing');
});
