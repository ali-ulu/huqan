'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { manageGate, PROFILES } = require('../lib/external-action-gate-install');

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-install-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
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
    assert.equal(second.target, first.target, profile);
    assert.equal(manageGate('status', options(paths, profile)).clients[0].installed, true, profile);
    assert.equal(manageGate('uninstall', options(paths, profile)).removed, true, profile);
    assert.equal(manageGate('status', options(paths, profile)).clients[0].installed, false, profile);
  }
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
