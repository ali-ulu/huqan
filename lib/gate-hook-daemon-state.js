'use strict';

// Where the gate daemon keeps its machine-local state, and the process/file
// primitives that state needs: the socket path, its pid/log/identity siblings,
// the environment fingerprint the client compares before it trusts an answer,
// symlink-safe writes, and pid liveness. Split out of lib/gate-hook-daemon.js,
// which sits at the 400-line budget (#328) and would cross it with the
// hardening added for #4597. Leaf-ish: node builtins plus lib/huqan-state-root.js.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultStateRoot, ensureStateRootDir } = require('./huqan-state-root');

const DEFAULT_PIPE_NAME = 'huqan-gate-daemon';

// Per-process variables that never change a verdict. The daemon and the hook
// client are different processes and legitimately differ on these, so they are
// excluded from the environment identity below.
const VOLATILE_ENVIRONMENT = Object.freeze(['_', 'PWD', 'OLDPWD', 'SHLVL']);

// Variables that differ between the daemon and the hook client by design, or
// between any two processes: they never change a verdict, so they are excluded
// from the identity hash. Everything else is included -- a false mismatch only
// costs the one-shot fallback, while a missed variable could return the wrong
// verdict.
const IDENTITY_EXCLUDED = Object.freeze([
  ...VOLATILE_ENVIRONMENT, 'HUQAN_GATE_DAEMON', 'HUQAN_GATE_DAEMON_SOCKET',
]);

function stateDir(env = process.env) {
  return ensureStateRootDir(defaultStateRoot(env));
}

/**
 * The socket the daemon listens on. `HUQAN_GATE_DAEMON_SOCKET` names it for a
 * deployment; otherwise it lives in the operator's own state root, keyed by
 * user id so two users on one host never share a gate. Windows has no unix
 * sockets here, so it uses a named pipe instead.
 *
 * The state root (0700, owner-only) rather than the shared temp directory: the
 * socket, its pid file and its log are all written there, and a predictable
 * path in a world-writable directory is a symlink target. lib/huqan-state-root.js
 * is the repo's one answer to "where does HUQAN keep machine-local state", so
 * the gate uses it too.
 */
function socketPath(env = process.env) {
  const named = env.HUQAN_GATE_DAEMON_SOCKET;
  if (named) return named;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${DEFAULT_PIPE_NAME}`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(stateDir(env), `gate-daemon-${uid}.sock`);
}

/**
 * A named pipe is not a filesystem path: `\\.\pipe\x` cannot carry a `.pid` or
 * `.log` suffix, and on Windows the daemon failed to start on exactly that
 * (ENOENT opening `\\.\pipe\x.log`). A unix socket is a real path, so its pid
 * and log sit beside it; a pipe's live in the state root under the pipe's own
 * name, which is still unique per deployment.
 */
function stateFilePath(sock, suffix, env = process.env) {
  if (!sock.startsWith('\\\\')) return `${sock}${suffix}`;
  return path.join(stateDir(env), `${path.win32.basename(sock)}${suffix}`);
}

function pidPath(sock = socketPath()) {
  return stateFilePath(sock, '.pid');
}

function logPath(sock = socketPath()) {
  return stateFilePath(sock, '.log');
}

function identityPath(sock = socketPath()) {
  return stateFilePath(sock, '.identity');
}

/**
 * A stable fingerprint of everything that can change a verdict: the working
 * directory (relative path arguments resolve against it) and the environment
 * (the AURA signal switch, the policy path, the state root, ...). The daemon
 * records its own when it starts; the client compares before it trusts an
 * answer. A mismatch means "no daemon": the call falls back to the one-shot
 * path, which evaluates in the caller's own cwd and environment. Sending the
 * environment per request is deliberately avoided -- it would carry unrelated
 * variables across a process boundary.
 */
function evaluationIdentity(env = process.env, cwd = process.cwd()) {
  const pairs = Object.keys(env)
    .filter((name) => !IDENTITY_EXCLUDED.includes(name))
    .sort()
    .map((name) => [name, env[name]]);
  // A structured encoding, not `name=value` joined by newlines: a value that
  // contains a newline could otherwise mimic the next entry, so two different
  // environments would hash the same and a verdict would be trusted under the
  // wrong one. JSON.stringify escapes separators and embedded newlines, so
  // distinct environments always produce distinct input.
  return {
    cwd,
    environment: crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex'),
  };
}

function readIdentity(sock) {
  try {
    return JSON.parse(fs.readFileSync(identityPath(sock), 'utf8'));
  } catch {
    return null;
  }
}

function identitiesMatch(recorded, current) {
  return Boolean(recorded) && recorded.cwd === current.cwd && recorded.environment === current.environment;
}

/**
 * Write a daemon state file without following a symlink and without replacing
 * an existing file. A predictable name in a directory another local user can
 * write is a symlink target otherwise: `writeFileSync` follows the link and
 * overwrites whatever it points at with the daemon's own bytes. O_NOFOLLOW
 * refuses a symlink, O_EXCL refuses to clobber, and 0600 keeps it owner-only.
 * The daemon owns these names, so a leftover from a crash is removed first.
 */
function writePrivate(target, contents) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  fs.rmSync(target, { force: true });
  fs.writeFileSync(target, contents, { flag: flags, mode: 0o600 });
}

/**
 * Open the daemon's log for append without following a symlink. The same
 * symlink concern as writePrivate: a link at the log path would send the
 * child's stdout/stderr to an attacker-chosen file.
 */
function openLogPrivate(target) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
    | (fs.constants.O_NOFOLLOW || 0);
  return fs.openSync(target, flags, 0o600);
}

function readPid(sock) {
  try {
    return Number(fs.readFileSync(pidPath(sock), 'utf8').trim());
  } catch {
    return NaN;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Whether a daemon is actually listening on `sock`. This is the ownership
 * proof `stopDaemon` needs: a pid file can survive a crash and the OS can
 * reuse that pid for an unrelated process, and signaling it would kill that
 * process. A listener that answers on our socket cannot be that stranger.
 */
function daemonListening(sock, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.connect(sock);
    let done = false;
    const end = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => end(false), timeoutMs);
    socket.on('connect', () => { clearTimeout(timer); end(true); });
    socket.on('error', () => { clearTimeout(timer); end(false); });
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = {
  DEFAULT_PIPE_NAME,
  socketPath,
  pidPath,
  logPath,
  identityPath,
  evaluationIdentity,
  readIdentity,
  identitiesMatch,
  writePrivate,
  openLogPrivate,
  readPid,
  isPidAlive,
  daemonListening,
  sleepSync,
};
