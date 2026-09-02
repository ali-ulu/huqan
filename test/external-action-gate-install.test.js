'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { manageGate, PROFILES } = require('../lib/external-action-gate-install');

const REPO_ROOT = path.resolve(__dirname, '..');

// The installed opencode/pi artifacts import `huqan` by bare specifier, so a
// workspace that cannot resolve the package is one where the gate would die on
// first load. Installs refuse that workspace now (#1792), so a sandbox that is
// meant to install successfully has to look like a real one: package present
// under the workspace's own node_modules. A junction is used because Windows
// needs no elevation for it and Node ignores the type elsewhere.
function linkPackage(root) {
  const target = path.join(root, 'node_modules', 'huqan');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(REPO_ROOT, target, 'junction');
}

function resolvableFrom(dir) {
  try { require.resolve('huqan', { paths: [dir] }); return true; } catch (_) { return false; }
}

function sandbox(t, { linked = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-install-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (linked) linkPackage(root);
  return { root, home };
}
function options(paths, profile) { return { ...paths, profile, deploymentAuthorized: true }; }

test('every supported profile installs idempotently, reports a blocked sentinel, and uninstalls only itself', t => {
  const paths = sandbox(t);
  for (const profile of PROFILES) {
    const first = manageGate('install', options(paths, profile));
    const second = manageGate('install', options(paths, profile));
    assert.equal(first.sentinel.live, true, profile);
    assert.equal(first.sentinel.decision, 'block', profile);
    // The sentinel says what it actually exercised: the evaluator in this
    // process, not the installed artifact under its host.
    assert.equal(first.sentinel.via, 'evaluator', profile);
    assert.equal(second.target, first.target, profile);
    assert.equal(manageGate('status', options(paths, profile)).clients[0].installed, true, profile);
    assert.equal(manageGate('uninstall', options(paths, profile)).removed, true, profile);
    assert.equal(manageGate('status', options(paths, profile)).clients[0].installed, false, profile);
  }
});

test('a workspace that cannot resolve huqan is refused, and refusing leaves nothing behind', t => {
  // The defect this guards against (#1792): install reported installed: true and
  // a blocked sentinel while the artifact it wrote could not be loaded at all
  // -- ERR_MODULE_NOT_FOUND on the bare `huqan` import. A global npm install
  // does not satisfy that import, so the check has to look at the workspace.
  const paths = sandbox(t, { linked: false });

  // Node resolves a bare specifier by walking up, so a machine that happens to
  // have huqan installed above the OS temp directory makes this workspace
  // genuinely resolvable -- and accepting the install there is the correct
  // answer, not a defect. Skip rather than assert a falsehood about the host.
  if (resolvableFrom(paths.root)) {
    t.diagnostic('skipped: huqan resolves from an ancestor of the sandbox on this host');
    return;
  }

  for (const profile of ['opencode', 'pi']) {
    assert.throws(() => manageGate('install', options(paths, profile)), /not resolvable/, profile);
    const status = manageGate('status', options(paths, profile)).clients[0];
    assert.equal(status.installed, false, profile);
    assert.equal(fs.existsSync(status.target), false, profile);
  }

  // Same workspace, package now present: the install goes through.
  linkPackage(paths.root);
  assert.equal(manageGate('install', options(paths, 'opencode')).installed, true);
});

test('JSON hook install preserves unrelated hooks and keeps one HUQAN entry', t => {
  const paths = sandbox(t);
  const target = path.join(paths.root, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const unrelated = { matcher: 'safe', hooks: [{ type: 'command', command: 'other-hook' }] };
  const similar = { matcher: 'mine', hooks: [{ type: 'command', command: 'other-hook --profile codex' }] };
  fs.writeFileSync(target, JSON.stringify({ description: 'mine', hooks: { PreToolUse: [unrelated, similar] } }));
  manageGate('install', options(paths, 'codex'));
  manageGate('install', options(paths, 'codex'));
  const installed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(installed.description, 'mine');
  assert.equal(installed.hooks.PreToolUse.length, 3);
  assert.deepEqual(installed.hooks.PreToolUse[0], unrelated);
  manageGate('uninstall', options(paths, 'codex'));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.PreToolUse, [unrelated, similar]);
});

test('malformed configs and modified owned files fail without overwrite or removal', t => {
  const paths = sandbox(t);
  const codex = path.join(paths.root, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, JSON.stringify({ hooks: { PreToolUse: {} } }));
  assert.throws(() => manageGate('install', options(paths, 'codex')), /PreToolUse must be an array/);

  fs.writeFileSync(codex, JSON.stringify({ hooks: { PreToolUse: [{
    matcher: 'modified', hooks: [{ type: 'command', command: 'huqan-gate --profile codex' }],
  }] } }));
  assert.throws(() => manageGate('install', options(paths, 'codex')), /modified HUQAN hook/);
  assert.throws(() => manageGate('uninstall', options(paths, 'codex')), /modified HUQAN hook/);

  const openCode = manageGate('install', options(paths, 'opencode'));
  fs.appendFileSync(openCode.target, '\n// local change\n');
  assert.throws(() => manageGate('install', options(paths, 'opencode')), /refusing to overwrite/);
  assert.throws(() => manageGate('uninstall', options(paths, 'opencode')), /refusing to remove/);
  assert.equal(fs.existsSync(openCode.target), true);
});

test('management API requires deployment authority and CLI exposes status', t => {
  const paths = sandbox(t);
  assert.throws(() => manageGate('install', { ...paths, profile: 'codex' }), /deployment authority/);
  const install = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'bin', 'huqan-gate-hook.js'),
    'install', '--profile', 'codex', '--target-root', paths.root, '--home', paths.home,
  ], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(JSON.parse(install.stdout).sentinel.decision, 'block');
  const cli = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'bin', 'huqan-gate-hook.js'),
    'status', '--profile', 'codex', '--target-root', paths.root, '--home', paths.home,
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).clients[0].installed, true);
});
