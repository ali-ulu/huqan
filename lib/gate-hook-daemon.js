'use strict';

// The gate daemon: one long-lived process that answers PreToolUse/PostToolUse
// hook calls over a local socket, so a call pays the ~140 ms module-load cost
// once instead of on every agent tool call.
//
// Why this exists: `bin/huqan-gate-hook.js` loads the whole evaluation chain
// (the adapter, the receipt writer and their 130+ transitive modules) before it
// can read a payload. A one-shot call spends almost all of its wall time in
// that load, not in the decision. The daemon keeps the chain resident and runs
// the exact same `runHookEvaluation` per request, so the verdict, the receipt
// and the fail-closed exit codes are unchanged -- only the process lifetime is.
//
// Boundary rules, so the daemon never becomes a second authority:
//   * It listens on a local socket only (a unix socket, or a named pipe on
//     Windows). It never opens a TCP port.
//   * It only serves the hook path. Report, management, identity and
//     break-glass commands stay one-shot; an operator runs them by hand.
//   * Requests are handled one at a time. The evaluation reads argv and stdin
//     through one invocation slot (lib/gate-hook-input.js), so serial handling
//     is what keeps two calls from seeing each other's input.
//   * It holds no state between calls beyond the require cache. Every request
//     builds its own receipt writer and closes it, exactly as one-shot does.
//   * Any error in serving a request is answered fail-closed (exit 2), never a
//     quiet allow.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_SOCKET_NAME = 'huqan-gate-daemon.sock';
const DEFAULT_PIPE_NAME = 'huqan-gate-daemon';

/**
 * The socket the daemon listens on. `HUQAN_GATE_DAEMON_SOCKET` names it for a
 * deployment; otherwise it lives in the temp directory, keyed by user id so two
 * users on one host never share a gate. Windows has no unix sockets here, so it
 * uses a named pipe instead.
 */
function socketPath(env = process.env) {
  const named = env.HUQAN_GATE_DAEMON_SOCKET;
  if (named) return named;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${DEFAULT_PIPE_NAME}`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `huqan-gate-daemon-${uid}.sock`);
}

function pidPath(sock = socketPath()) {
  return `${sock}.pid`;
}

function isDaemonEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.HUQAN_GATE_DAEMON || ''));
}

/**
 * One request to the daemon: the hook argv and the raw payload it would have
 * read from stdin. A request is a single JSON line; the response is a single
 * JSON line carrying the bytes the one-shot call would have written.
 */
function encodeRequest(request) {
  return `${JSON.stringify(request)}\n`;
}

function decodeResponse(line) {
  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed !== 'object') throw new Error('malformed daemon response');
  if (typeof parsed.stdout !== 'string' || typeof parsed.stderr !== 'string') {
    throw new Error('malformed daemon response');
  }
  if (!Number.isInteger(parsed.exitCode)) throw new Error('malformed daemon response');
  return parsed;
}

/**
 * Ask the daemon to evaluate one invocation. Resolves with the response, or
 * rejects. The caller (bin/huqan-gate-hook.js) treats a rejection as "no
 * daemon" and falls back to a one-shot evaluation, so a missing or broken
 * daemon costs latency, never a decision.
 *
 * `connectTimeoutMs` bounds only the wait to connect. Once the request is sent
 * the client waits without a short cap: re-running an already-sent evaluation
 * one-shot would write a second receipt for one action, so a slow answer must
 * not turn into a second verdict.
 */
function requestDaemon({ argv, stdin, sock = socketPath(), connectTimeoutMs = 250, responseTimeoutMs = 25000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const socket = net.connect(sock);
    let buffer = '';
    let sent = false;

    const connectTimer = setTimeout(() => {
      socket.destroy();
      finish(reject, new Error('daemon connect timed out'));
    }, connectTimeoutMs);

    const responseTimer = () => setTimeout(() => {
      socket.destroy();
      finish(reject, new Error('daemon response timed out'));
    }, responseTimeoutMs);
    let timer = null;

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      sent = true;
      timer = responseTimer();
      socket.write(encodeRequest({ argv, stdin }));
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        finish(reject, new Error('daemon response too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      socket.end();
      try {
        finish(resolve, decodeResponse(line));
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.on('error', (error) => {
      // A failure before the request is sent is "no daemon" (fall back). A
      // failure after is a real error the caller must not paper over by
      // re-running the action.
      finish(reject, sent ? new Error(`daemon request failed after send: ${error.message}`) : error);
    });
    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (timer) clearTimeout(timer);
      if (!settled && !sent) finish(reject, new Error('daemon connection closed'));
      else if (!settled) finish(reject, new Error('daemon closed before answering'));
    });
  });
}

/**
 * Serve hook calls until stopped. The server requires the evaluation chain
 * lazily, so a process that only ever runs `status`/`stop` never pays for it.
 */
function runDaemonServer({ sock = socketPath(), log = console } = {}) {
  const { runHookEvaluation } = require('./gate-hook-evaluate');
  const { runWithInvocation } = require('./gate-hook-input');
  const { hookContextFor } = require('./gate-hook-context');

  if (process.platform !== 'win32' && fs.existsSync(sock)) {
    // A socket file with no live listener is stale after a crash; remove it so
    // the daemon can bind. A live one is a second daemon, which must not start.
    if (!isPidAlive(readPid(sock))) fs.rmSync(sock, { force: true });
  }

  let queue = Promise.resolve();
  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      // Serial: the evaluation reads one invocation slot, so requests must not
      // overlap. The queue is the ordering guarantee.
      queue = queue.then(() => handleRequest(line, socket, { runHookEvaluation, runWithInvocation, hookContextFor, log }));
    });
    socket.on('error', () => {});
  });

  server.on('error', (error) => {
    log.error(`HUQAN gate daemon failed to listen on ${sock}: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(sock, () => {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(sock, 0o600); } catch { /* best effort: owner-only */ }
    }
    fs.writeFileSync(pidPath(sock), `${process.pid}\n`);
    log.log(`HUQAN gate daemon listening on ${sock} (pid ${process.pid})`);
  });

  const shutdown = () => {
    server.close();
    if (process.platform !== 'win32') fs.rmSync(sock, { force: true });
    fs.rmSync(pidPath(sock), { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

async function handleRequest(line, socket, { runHookEvaluation, runWithInvocation, hookContextFor, log }) {
  let response;
  try {
    const request = JSON.parse(line);
    if (!request || !Array.isArray(request.argv)) throw new Error('malformed daemon request');
    const stdout = [];
    const stderr = [];
    const io = {
      out: (text) => stdout.push(text),
      err: (text) => stderr.push(text),
      // The daemon outlives the call: it must not set process.exitCode, which
      // would end the server. The exit code travels back in the response.
      setExitCode: () => {},
    };
    let exitCode = 2;
    const argv = request.argv;
    const command = argv[2];
    // The same per-invocation context the one-shot path builds. A daemon that
    // dropped --aura-signals or the approval-authority verifier would change a
    // verdict, so this is required, not optional.
    await runWithInvocation({ argv, stdin: String(request.stdin ?? '') }, async () => {
      exitCode = await runHookEvaluation(command, { io, ...hookContextFor(argv) });
    });
    response = { stdout: stdout.join(''), stderr: stderr.join(''), exitCode };
  } catch (error) {
    // Fail-closed: a request the daemon cannot evaluate is a refusal, never a
    // silent allow, and never a crash that takes the listener down with it.
    log.error(`HUQAN gate daemon request failed closed: ${error?.message || error}`);
    response = { stdout: '', stderr: `HUQAN external action guard failed closed: ${error?.message || error}\n`, exitCode: 2 };
  }
  socket.write(`${JSON.stringify(response)}\n`);
  socket.end();
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
 * Start the daemon in the background and wait for its socket. Returns the pid.
 * The child is detached so it outlives this call; it logs to `logPath` so an
 * operator can read why a start failed.
 */
function startDaemon({ sock = socketPath(), entry = path.join(__dirname, '..', 'bin', 'huqan-gate-hook.js'), env = process.env, waitMs = 5000 } = {}) {
  if (daemonStatus({ sock }).running) {
    return { started: false, alreadyRunning: true, pid: readPid(sock), socket: sock };
  }
  const logPath = `${sock}.log`;
  const out = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [entry, 'daemon', 'serve'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...env, HUQAN_GATE_DAEMON_SOCKET: sock },
  });
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (daemonStatus({ sock }).running) return { started: true, pid: readPid(sock), socket: sock };
    sleepSync(50);
  }
  return { started: false, alreadyRunning: false, pid: readPid(sock), socket: sock, logPath };
}

function stopDaemon({ sock = socketPath(), waitMs = 3000 } = {}) {
  const pid = readPid(sock);
  if (!isPidAlive(pid)) {
    if (process.platform !== 'win32') fs.rmSync(sock, { force: true });
    fs.rmSync(pidPath(sock), { force: true });
    return { stopped: false, reason: 'not running' };
  }
  process.kill(pid, 'SIGTERM');
  // The daemon removes its own socket in its SIGTERM handler, so a gone socket
  // is the signal that it is down. The pid alone is not enough: a detached
  // child is reparented on exit and, where nothing reaps it, lingers as a
  // zombie that `kill(pid, 0)` still reports as alive.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const socketGone = process.platform !== 'win32' && !fs.existsSync(sock);
    if (socketGone || !isPidAlive(pid)) return { stopped: true, pid };
    sleepSync(50);
  }
  return { stopped: false, pid, reason: 'did not exit in time' };
}

function daemonStatus({ sock = socketPath() } = {}) {
  const pid = readPid(sock);
  const alive = isPidAlive(pid);
  const socketPresent = process.platform === 'win32' ? alive : fs.existsSync(sock);
  return { running: alive && socketPresent, pid: alive ? pid : null, socket: sock, socketPresent };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = {
  socketPath,
  pidPath,
  isDaemonEnabled,
  requestDaemon,
  runDaemonServer,
  startDaemon,
  stopDaemon,
  daemonStatus,
};
