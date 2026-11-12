'use strict';

// The gate daemon (perf): one long-lived process answers hook calls over a
// local socket so a call does not pay the module-load cost every time.
//
// What this file must prove, because the daemon sits on the admission path:
//   1. It answers the same verdict as a one-shot call, allow and deny alike.
//   2. It is off unless the deployment opts in (HUQAN_GATE_DAEMON).
//   3. A missing or unreachable daemon falls back to the one-shot path, so a
//      decision is never lost to the daemon.
//   4. A broken request fails closed (exit 2), never a quiet allow, and the
//      listener survives to answer the next call.
//   5. The per-invocation context is preserved: a daemon call and a one-shot
//      call build the same hook context, so --aura-signals is not dropped.
//
// Each test drives the real `bin/huqan-gate-hook.js` process against a real
// daemon on a private socket, so the protocol and the exit codes are exercised,
// not a stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'bin', 'huqan-gate-hook.js');
const daemon = require('../lib/gate-hook-daemon');

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-daemon-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

function socketIn(directory) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\huqan-gate-daemon-test-${path.basename(directory)}`
    : path.join(directory, 'gate.sock');
}

function baseEnv(sock, dir) {
  return {
    ...process.env,
    HUQAN_DISABLE_API_AUTH: '1',
    HUQAN_GATE_DAEMON_SOCKET: sock,
    // Keep every daemon state file (pid, log, identity) inside the test
    // sandbox. Without this, a Windows named pipe's pid/log land in the
    // operator's real state root.
    HUQAN_STATE_ROOT: path.join(dir, 'state'),
  };
}

function startDaemon(t, sock, dir) {
  const env = baseEnv(sock, dir);
  const started = spawnSync(process.execPath, [HOOK, 'daemon', 'start'], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(started.status, 0, `daemon start failed: ${started.stderr}`);
  const { pid } = JSON.parse(started.stdout);
  assert.ok(pid, 'daemon start must report a pid');
  t.after(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  return pid;
}

function callHook(args, payload, env) {
  return spawnSync(process.execPath, [HOOK, ...args], { cwd: ROOT, encoding: 'utf8', input: payload, env });
}

const ALLOW = JSON.stringify({ tool_name: 'Bash', session_id: 's', tool_input: { command: 'git status' } });
const DENY = JSON.stringify({ tool_name: 'Bash', session_id: 's', tool_input: { command: 'git push --force' } });

test('a daemon answers the same allow and deny a one-shot call does', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  startDaemon(t, sock, dir);
  const env = { ...baseEnv(sock, dir), HUQAN_GATE_DAEMON: '1' };

  const allowed = callHook(['--profile', 'claude-code'], ALLOW, env);
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), '{}', 'an allowed call writes an empty object');

  const denied = callHook(['--profile', 'claude-code'], DENY, env);
  assert.equal(denied.status, 0);
  const verdict = JSON.parse(denied.stdout);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /blocked/i);
});

test('the daemon is off unless the deployment opts in', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  startDaemon(t, sock, dir);
  // No HUQAN_GATE_DAEMON: the call must not talk to the daemon even though it
  // is running. The verdict is the same either way; the path is what differs.
  const result = callHook(['--profile', 'claude-code'], ALLOW, baseEnv(sock, dir));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '{}');
  assert.equal(daemon.isDaemonEnabled({ HUQAN_GATE_DAEMON: '' }), false);
  assert.equal(daemon.isDaemonEnabled({ HUQAN_GATE_DAEMON: '1' }), true);
});

test('a missing daemon falls back to the one-shot path and still decides', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir); // nothing is listening here
  const env = { ...baseEnv(sock, dir), HUQAN_GATE_DAEMON: '1' };

  const denied = callHook(['--profile', 'claude-code'], DENY, env);
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny',
    'the fallback must reach the same verdict, not allow by default');
});

test('a malformed request fails closed and the listener keeps serving', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  startDaemon(t, sock, dir);

  // Speak the protocol by hand: a request with no argv is not evaluable, and
  // the answer must be a refusal, not a crash.
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock, () => {
      socket.write(`${JSON.stringify({ stdin: '{}' })}\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('end', () => {
      try {
        const response = JSON.parse(buffer.trim());
        assert.equal(response.exitCode, 2, 'a request the daemon cannot evaluate is a refusal');
        assert.match(response.stderr, /failed closed/);
      } catch (error) { reject(error); return; }
      // The listener is still up: the next call is answered normally.
      const env = { ...baseEnv(sock, dir), HUQAN_GATE_DAEMON: '1' };
      const after = callHook(['--profile', 'claude-code'], ALLOW, env);
      assert.equal(after.status, 0);
      assert.equal(after.stdout.trim(), '{}');
      resolve();
    });
    socket.on('error', reject);
  });
});

test('a daemon call and a one-shot call build the same hook context', () => {
  const { hookContextFor } = require('../lib/gate-hook-context');
  // The verifier is always wired; the signal provider appears only with the
  // flag. A daemon that skipped hookContextFor would drop both, which is a
  // verdict change, not a performance one.
  const plain = hookContextFor(['node', HOOK, '--profile', 'claude-code']);
  assert.equal(typeof plain.verifyAutonomyActivation, 'function');
  assert.equal(plain.signalProvider, undefined);

  const flagged = hookContextFor(['node', HOOK, '--profile', 'claude-code', '--aura-signals']);
  assert.equal(typeof flagged.signalProvider, 'function', '--aura-signals must reach the daemon context');
});

test('the daemon status is a read: it does not start a daemon', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  const status = spawnSync(process.execPath, [HOOK, 'daemon', 'status'], { cwd: ROOT, encoding: 'utf8', env: baseEnv(sock, dir) });
  assert.equal(status.status, 0);
  const report = JSON.parse(status.stdout);
  assert.equal(report.running, false);
  assert.equal(fs.existsSync(sock), false, 'status must not leave a socket behind');
});

test('a second daemon start is a no-op, and stop removes the socket', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  const pid = startDaemon(t, sock, dir);

  const again = spawnSync(process.execPath, [HOOK, 'daemon', 'start'], { cwd: ROOT, encoding: 'utf8', env: baseEnv(sock, dir) });
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(again.stdout).started, false, 'a running daemon is not started twice');

  const stopped = spawnSync(process.execPath, [HOOK, 'daemon', 'stop'], { cwd: ROOT, encoding: 'utf8', env: baseEnv(sock, dir) });
  assert.equal(stopped.status, 0);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
  assert.equal(daemon.daemonStatus({ sock }).running, false, 'the daemon is no longer reported running');
});

// A named pipe is not a filesystem path, so `\\.\pipe\x` cannot carry a `.pid`
// or `.log` suffix. Doing that on Windows made `daemon start` fail closed with
// ENOENT opening `\\.\pipe\x.log`; this pins the split.
test('a named-pipe socket keeps its pid and log beside the pipe name, not on it', () => {
  const pipe = '\\\\.\\pipe\\huqan-gate-daemon-test-abc';
  const pid = daemon.pidPath(pipe);
  const log = daemon.logPath(pipe);
  assert.ok(!pid.startsWith('\\\\'), `pid path is a real path, got ${pid}`);
  assert.match(pid, /huqan-gate-daemon-test-abc\.pid$/);
  assert.match(log, /huqan-gate-daemon-test-abc\.log$/);
});

// The daemon evaluates with the environment and cwd it started with. When the
// caller's differ, an answer would describe a different evaluation, so the call
// must fall back before it sends anything -- never a verdict from the wrong
// environment, and never a second receipt for the same action.
test('a call whose environment differs from the daemon\'s falls back, not to a stale verdict', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  startDaemon(t, sock, dir);

  // Same socket, same cwd, but a verdict-relevant variable the daemon did not
  // start with. The daemon's identity file cannot match, so the client falls
  // back one-shot and the decision is still correct.
  const env = { ...baseEnv(sock, dir), HUQAN_GATE_DAEMON: '1', GATE_AURA_SIGNALS: '1' };
  const denied = callHook(['--profile', 'claude-code'], DENY, env);
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const allowed = callHook(['--profile', 'claude-code'], ALLOW, env);
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), '{}');
});

// A predictable pid/log path is a symlink target when the state directory is
// writable by another local user. The daemon owns these names, so it removes
// the link and writes a fresh regular file -- it must never follow the link and
// overwrite whatever it points at.
test('state files are written without following a symlink', (t) => {
  const dir = scratch(t);
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'victim');
  fs.writeFileSync(target, 'original\n');
  const link = path.join(state, 'daemon.pid');
  try {
    fs.symlinkSync(target, link);
  } catch {
    t.skip('this platform cannot create a symlink without extra privilege');
    return;
  }

  const { writePrivate } = require('../lib/gate-hook-daemon-state');
  writePrivate(link, '999\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n', 'the symlink target is untouched');
  // Everything about the written file is read through one descriptor: opening
  // with O_NOFOLLOW fails if the name is still a symlink, and fstat/read on the
  // same fd describe that one file, so no path is checked and then used again.
  const fd = fs.openSync(link, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    assert.equal(fs.fstatSync(fd).isSymbolicLink(), false, 'the link is replaced by a regular file');
    assert.equal(fs.readFileSync(fd, 'utf8'), '999\n');
    // Windows ignores the mode bits (it ACLs the file instead), so a mode
    // assertion there would describe nothing.
    if (process.platform !== 'win32') {
      assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600, 'the state file is owner-only');
    }
  } finally {
    fs.closeSync(fd);
  }
});

// The identity hash must distinguish environments that differ only by where a
// newline sits. Joining `name=value` with '\n' let `A="x\nGATE_AURA_SIGNALS=1"`
// collide with `A="x"` plus `GATE_AURA_SIGNALS="1"`, so the client would accept
// a verdict computed without its aura setting. The structured encoding keeps
// them apart.
test('the environment identity does not collide across a newline in a value', () => {
  const { evaluationIdentity } = require('../lib/gate-hook-daemon-state');
  const cwd = '/tmp';
  const smuggled = evaluationIdentity({ A: 'x\nGATE_AURA_SIGNALS=1' }, cwd);
  const split = evaluationIdentity({ A: 'x', GATE_AURA_SIGNALS: '1' }, cwd);
  assert.notEqual(smuggled.environment, split.environment,
    'a newline in a value must not mimic a second variable');
});

// A live daemon's socket must never be removed just because its pid file is
// missing: removing it would let a second daemon bind while the first still
// serves. Ownership is decided by the socket answering, not by the pid file.
test('a live socket is not removed when its pid file is missing', async (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  startDaemon(t, sock, dir);
  fs.rmSync(daemon.pidPath(sock), { force: true });

  const second = spawnSync(process.execPath, [HOOK, 'daemon', 'serve'], { cwd: ROOT, encoding: 'utf8', env: baseEnv(sock, dir), timeout: 8000 });
  assert.notEqual(second.status, 0, 'a second serve must refuse a socket a daemon already owns');
  // A unix socket is a file; a Windows named pipe is not, so the existence
  // check describes only the posix path.
  if (process.platform !== 'win32') {
    assert.equal(fs.existsSync(sock), true, 'the live socket is left in place');
  }

  // The original daemon is still the one answering.
  const env = { ...baseEnv(sock, dir), HUQAN_GATE_DAEMON: '1' };
  const allowed = callHook(['--profile', 'claude-code'], ALLOW, env);
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), '{}');
});

// A client that connects and sends nothing must not stall a graceful shutdown.
// server.close() waits for open connections, so an idle one is dropped.
test('an idle connection does not stall the daemon stop', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  startDaemon(t, sock, dir);

  const idle = net.connect(sock);
  idle.on('error', () => {});
  t.after(() => idle.destroy());

  const stopped = spawnSync(process.execPath, [HOOK, 'daemon', 'stop'], { cwd: ROOT, encoding: 'utf8', env: baseEnv(sock, dir), timeout: 8000 });
  assert.equal(stopped.status, 0, `stop must not time out on an idle connection: ${stopped.stderr}`);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
});

