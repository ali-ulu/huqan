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
    // The sentinel says which surface it actually exercised: installed
    // artifacts for file/Hermes profiles and the recorded command for JSON.
    const expectedVia = { opencode: 'artifact', pi: 'artifact', hermes: 'artifact', 'claude-code': 'command', codex: 'command' };
    assert.equal(first.sentinel.via, expectedVia[profile], profile);
    assert.equal(first.sentinel.receiptWritten, true, profile);
    // The denylist is what the sentinel is written to prove. Pi used to block
    // as `malformed_external_action_blocked` because the payload was shaped for
    // a different profile -- a green sentinel that proved the wrong path.
    assert.equal(first.sentinel.reason, 'DENYLISTED_COMMAND_BLOCKED', profile);
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

test('an installed artifact that cannot reach the guard API fails the install and leaves nothing behind', t => {
  // The other half of #1792: the workspace resolves `huqan`, so the dependency
  // check passes, but the resolved package predates the guard API -- exactly
  // the published huqan@0.11.1 on the machine where this was found. The old
  // sentinel called the evaluator inside its own process and reported
  // `live: true` over an artifact that dies the moment its host loads it.
  const paths = sandbox(t, { linked: false });
  const stub = path.join(paths.root, 'node_modules', 'huqan');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: 'huqan', version: '0.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(stub, 'index.js'), 'module.exports = {};\n');

  for (const profile of ['opencode', 'pi']) {
    assert.throws(() => manageGate('install', options(paths, profile)), /installed artifact is not loadable/, profile);
    const status = manageGate('status', options(paths, profile)).clients[0];
    assert.equal(status.installed, false, profile);
    assert.equal(fs.existsSync(status.target), false, profile);
  }
});

test('the sentinel keeps its synthetic block out of the deployment receipt trail', t => {
  // The sentinel is a fabricated `rm -rf /`. It has to write a receipt --
  // that is how a blocking artifact proves it still leaves evidence (#1794) --
  // but writing it where auditors read would open the trail with a block that
  // never happened.
  const paths = sandbox(t);
  const trail = path.join(paths.root, 'deployment-receipts.jsonl');
  const previous = process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS;
  process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS = trail;
  t.after(() => {
    if (previous === undefined) delete process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS;
    else process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS = previous;
  });
  assert.equal(manageGate('install', options(paths, 'opencode')).sentinel.receiptWritten, true);
  assert.equal(fs.existsSync(trail), false);
});

test('the recorded hook command runs in every shell a host might hand it to', t => {
  // Codex hands hook commands to PowerShell, where `"C:\Program Files\...\
  // node.exe" script.js` is a parser error -- the hook exited 1, wrote no
  // receipt, and Codex ran the tool anyway (#1797). cmd.exe runs that same
  // string happily, which is exactly why validating under one shell is not
  // validating.
  const paths = sandbox(t);
  for (const profile of ['claude-code', 'codex']) {
    const install = manageGate('install', options(paths, profile));
    assert.equal(install.sentinel.via, 'command', profile);
    assert.equal(install.sentinel.receiptWritten, true, profile);
    assert.deepEqual(install.sentinel.shells, process.platform === 'win32' ? ['cmd', 'powershell'] : ['sh'], profile);
    assert.equal(install.sentinel.command.includes('"'), false, profile);
    const recorded = JSON.parse(fs.readFileSync(install.target, 'utf8')).hooks.PreToolUse
      .flatMap(entry => entry.hooks).map(hook => hook.command);
    assert.deepEqual(recorded, [install.sentinel.command], profile);
  }
});

test('the recorded command still blocks when run the way the host runs it', t => {
  // End of the chain: not "a command like this one works" but "this exact
  // string, through this shell, denies the action and leaves a receipt".
  const paths = sandbox(t);
  const install = manageGate('install', options(paths, 'codex'));
  const trail = path.join(paths.root, 'host-receipts.jsonl');
  const shell = process.platform === 'win32'
    ? { file: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-Command', install.sentinel.command] }
    : { file: '/bin/sh', argv: ['-c', install.sentinel.command] };
  const run = spawnSync(shell.file, shell.argv, {
    input: JSON.stringify({ session_id: 's', tool_use_id: 't', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: paths.root }),
    encoding: 'utf8',
    env: { ...process.env, HUQAN_EXTERNAL_GUARD_RECEIPTS: trail, HUQAN_MEMORY_PATH: path.join(paths.root, 'memory.json'), HUQAN_DB_PATH: path.join(paths.root, 'memory.db') },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(trail, 'utf8').trim().split(/\r?\n/).length, 1);
});

test('a gate spelling that cannot run is skipped for one that can', t => {
  // HUQAN_GATE_PATH is the most explicit candidate, so it is tried first --
  // but it is still only recorded if it actually blocks the sentinel. When it
  // cannot run, the install falls through rather than writing it.
  const paths = sandbox(t);
  const previous = process.env.HUQAN_GATE_PATH;
  process.env.HUQAN_GATE_PATH = path.join(paths.root, 'nowhere', 'huqan-gate');
  t.after(() => {
    if (previous === undefined) delete process.env.HUQAN_GATE_PATH;
    else process.env.HUQAN_GATE_PATH = previous;
  });
  const install = manageGate('install', options(paths, 'codex'));
  assert.equal(install.sentinel.command.includes('nowhere'), false);
  assert.equal(install.sentinel.decision, 'block');
});

test('Hermes records the tested gate argv and no longer depends on host PATH', t => {
  const paths = sandbox(t);
  const previous = process.env.HUQAN_GATE_PATH;
  process.env.HUQAN_GATE_PATH = path.join(paths.root, 'missing-after-install', 'huqan-gate');
  t.after(() => {
    if (previous === undefined) delete process.env.HUQAN_GATE_PATH;
    else process.env.HUQAN_GATE_PATH = previous;
  });
  const install = manageGate('install', options(paths, 'hermes'));
  const config = JSON.parse(fs.readFileSync(path.join(install.target, 'huqan-gate.json'), 'utf8'));
  assert.equal(config.schemaVersion, 1);
  assert.equal(Array.isArray(config.argv), true);
  assert.equal(config.argv.some(value => value.includes('huqan-gate-hook.js')), true);
  assert.equal(install.sentinel.via, 'artifact');
  assert.equal(install.sentinel.receiptWritten, true);
});

test('Hermes refuses to reclaim a locally modified gate command', t => {
  const paths = sandbox(t);
  const install = manageGate('install', options(paths, 'hermes'));
  const configPath = path.join(install.target, 'huqan-gate.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, argv: ['other-guard'] }));
  assert.equal(manageGate('status', options(paths, 'hermes')).clients[0].installed, false);
  assert.throws(() => manageGate('install', options(paths, 'hermes')), /modified Hermes gate command/);
  assert.throws(() => manageGate('uninstall', options(paths, 'hermes')), /modified Hermes gate command/);
});

test('an install over an unrunnable recorded command fails and removes nothing', t => {
  // This machine's state before the fix: a config already carrying a HUQAN
  // entry whose command the host cannot start. The install must not report
  // success over it -- and must not delete an entry it did not write.
  const paths = sandbox(t);
  const target = path.join(paths.root, '.codex', 'hooks.json');
  const stale = { matcher: '.*', hooks: [{ type: 'command', command: 'huqan-gate --profile codex', commandWindows: 'huqan-gate.cmd --profile codex', timeout: 30 }] };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ hooks: { PreToolUse: [stale] } }));
  if (spawnSync('huqan-gate', ['--help'], { shell: true }).status === 0) {
    t.diagnostic('skipped: huqan-gate is on PATH here, so the stale command is runnable');
    return;
  }
  assert.throws(() => manageGate('install', options(paths, 'codex')), /hook command/);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.PreToolUse, [stale]);
});

test('a hook command with local edits is left alone rather than reclaimed', t => {
  // Ownership is structural now, because the command is resolved per machine
  // and can no longer be compared to a fixed template string. It still has to
  // stop at commands this install could have written: an added flag is someone
  // else's decision, not ours to overwrite or remove.
  const paths = sandbox(t);
  const install = manageGate('install', options(paths, 'codex'));
  const config = JSON.parse(fs.readFileSync(install.target, 'utf8'));
  config.hooks.PreToolUse[0].hooks[0].command += ' --require-identity';
  config.hooks.PreToolUse[0].hooks[0].commandWindows += ' --require-identity';
  fs.writeFileSync(install.target, JSON.stringify(config));
  assert.equal(manageGate('status', options(paths, 'codex')).clients[0].installed, false);
  assert.throws(() => manageGate('install', options(paths, 'codex')), /modified HUQAN hook/);
  assert.throws(() => manageGate('uninstall', options(paths, 'codex')), /modified HUQAN hook/);
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

function codexTrustStore(root, entry) {
  const target = path.join(root, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `[hooks.state.'${entry}']\ntrusted_hash = "sha256:deadbeef"\n`);
}

test('an install that writes the hook entry says the host has to trust it again', t => {
  // Codex skips a hook whose trusted_hash it does not have, silently -- so a
  // reinstall disarmed the gate and nothing said so until a turn was measured
  // (#1797). The install cannot approve on the user's behalf; it can refuse to
  // let the fact go unmentioned.
  const paths = sandbox(t);
  const hooks = path.join(paths.root, '.codex', 'hooks.json');

  const untrusted = manageGate('install', options(paths, 'codex')).hostTrust;
  assert.equal(untrusted.record, 'absent');
  assert.equal(untrusted.reapprovalRequired, true);
  manageGate('uninstall', options(paths, 'codex'));

  codexTrustStore(paths.root, `${hooks}:pre_tool_use:0:0`);
  const rewritten = manageGate('install', options(paths, 'codex')).hostTrust;
  assert.equal(rewritten.record, 'present');
  assert.equal(rewritten.reapprovalRequired, true, 'a freshly written entry is not the one that was trusted');
  assert.match(rewritten.reason, /previous one/);

  // Second install changes nothing, so the record still describes what is there.
  assert.equal(manageGate('install', options(paths, 'codex')).hostTrust.reapprovalRequired, false);
});

test('trust state is readable without reinstalling, and only claimed for hosts that keep it', t => {
  const paths = sandbox(t);
  manageGate('install', options(paths, 'codex'));
  codexTrustStore(paths.root, `${path.join(paths.root, '.codex', 'hooks.json')}:pre_tool_use:0:0`);
  assert.equal(manageGate('status', options(paths, 'codex')).clients[0].hostTrust.reapprovalRequired, false);

  // A key for a different hook in the same store is not this hook's trust.
  codexTrustStore(paths.root, `${path.join(paths.root, '.codex', 'config.toml')}:session_start:0:0`);
  assert.equal(manageGate('status', options(paths, 'codex')).clients[0].hostTrust.record, 'absent');

  // No claim is made about hosts whose trust behaviour has not been measured.
  assert.equal(manageGate('status', options(paths, 'opencode')).clients[0].hostTrust, null);
});
