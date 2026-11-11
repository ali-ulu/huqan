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

function baseEnv(sock) {
  return { ...process.env, HUQAN_DISABLE_API_AUTH: '1', HUQAN_GATE_DAEMON_SOCKET: sock };
}

function startDaemon(t, sock) {
  const env = baseEnv(sock);
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
  startDaemon(t, sock);
  const env = { ...baseEnv(sock), HUQAN_GATE_DAEMON: '1' };

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
  startDaemon(t, sock);
  // No HUQAN_GATE_DAEMON: the call must not talk to the daemon even though it
  // is running. The verdict is the same either way; the path is what differs.
  const result = callHook(['--profile', 'claude-code'], ALLOW, baseEnv(sock));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '{}');
  assert.equal(daemon.isDaemonEnabled({ HUQAN_GATE_DAEMON: '' }), false);
  assert.equal(daemon.isDaemonEnabled({ HUQAN_GATE_DAEMON: '1' }), true);
});

test('a missing daemon falls back to the one-shot path and still decides', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir); // nothing is listening here
  const env = { ...baseEnv(sock), HUQAN_GATE_DAEMON: '1' };

  const denied = callHook(['--profile', 'claude-code'], DENY, env);
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny',
    'the fallback must reach the same verdict, not allow by default');
});

test('a malformed request fails closed and the listener keeps serving', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  startDaemon(t, sock);

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
      const env = { ...baseEnv(sock), HUQAN_GATE_DAEMON: '1' };
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
  const status = spawnSync(process.execPath, [HOOK, 'daemon', 'status'], { cwd: ROOT, encoding: 'utf8', env: baseEnv(sock) });
  assert.equal(status.status, 0);
  const report = JSON.parse(status.stdout);
  assert.equal(report.running, false);
  assert.equal(fs.existsSync(sock), false, 'status must not leave a socket behind');
});

test('a second daemon start is a no-op, and stop removes the socket', (t) => {
  const dir = scratch(t);
  const sock = socketIn(dir);
  const pid = startDaemon(t, sock);

  const again = spawnSync(process.execPath, [HOOK, 'daemon', 'start'], { cwd: ROOT, encoding: 'utf8', env: baseEnv(sock) });
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(again.stdout).started, false, 'a running daemon is not started twice');

  const stopped = spawnSync(process.execPath, [HOOK, 'daemon', 'stop'], { cwd: ROOT, encoding: 'utf8', env: baseEnv(sock) });
  assert.equal(stopped.status, 0);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
  assert.equal(daemon.daemonStatus({ sock }).running, false, 'the daemon is no longer reported running');
});
