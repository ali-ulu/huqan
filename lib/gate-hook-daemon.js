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
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
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
} = require('./gate-hook-daemon-state');

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

// A client that connects and sends nothing must not hold the listener open
// forever: server.close() waits for existing connections, so one idle socket
// would stall a graceful shutdown. A request that starts arriving is bounded
// by the client's own response timeout instead.
const REQUEST_DEADLINE_MS = 30000;

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
    // The daemon evaluates with the environment and cwd it started with. When
    // the caller's differ, an answer would describe a different evaluation, so
    // the caller falls back before sending anything -- nothing is evaluated
    // twice, and no receipt is written for this request.
    const identity = evaluationIdentity();
    if (!identitiesMatch(readIdentity(sock), identity)) {
      reject(new Error('daemon evaluation environment differs from this call'));
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    // Every failure after the request bytes were written stays failed closed:
    // the daemon may already have recorded the action, so the caller must not
    // re-run it one-shot. The marker is structured, not message text, so a
    // reworded message can never silently turn a post-send failure into a
    // fallback.
    const postSendError = (message) => Object.assign(new Error(message), { postSend: true });
    const socket = net.connect(sock);
    // Stateful decoding: a UTF-8 character split across two reads is otherwise
    // replaced with U+FFFD on both halves, and the evaluated text would differ
    // from the payload.
    socket.setEncoding('utf8');
    let buffer = '';
    let sent = false;

    const connectTimer = setTimeout(() => {
      socket.destroy();
      finish(reject, new Error('daemon connect timed out'));
    }, connectTimeoutMs);

    const responseTimer = () => setTimeout(() => {
      socket.destroy();
      finish(reject, postSendError('daemon response timed out'));
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
        finish(reject, postSendError('daemon response too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      socket.end();
      try {
        finish(resolve, decodeResponse(line));
      } catch (error) {
        finish(reject, Object.assign(error, { postSend: true }));
      }
    });
    socket.on('error', (error) => {
      // A failure before the request is sent is "no daemon" (fall back). A
      // failure after is a real error the caller must not paper over by
      // re-running the action.
      finish(reject, sent ? postSendError(`daemon request failed after send: ${error.message}`) : error);
    });
    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (timer) clearTimeout(timer);
      if (!settled && !sent) finish(reject, new Error('daemon connection closed'));
      else if (!settled) finish(reject, postSendError('daemon closed before answering'));
    });
  });
}

/**
 * Serve hook calls until stopped. The server requires the evaluation chain
 * lazily, so a process that only ever runs `status`/`stop` never pays for it.
 * Async because the stale-socket decision asks the socket whether a listener
 * answers. Returns the server, or null when another daemon already owns it.
 */
async function runDaemonServer({ sock = socketPath(), log = console } = {}) {
  const { runHookEvaluation } = require('./gate-hook-evaluate');
  const { runWithInvocation } = require('./gate-hook-input');
  const { hookContextFor } = require('./gate-hook-context');

  if (process.platform !== 'win32' && fs.existsSync(sock)) {
    // A socket file may be a leftover after a crash, or a live second daemon.
    // PID-file liveness cannot tell them apart -- a missing pid file reads as
    // NaN, and `isPidAlive(NaN)` is false -- so ask the socket itself. Only a
    // path no listener answers is stale and safe to remove; removing a live
    // one would let a second daemon bind while the first still runs.
    if (await daemonListening(sock)) {
      log.error(`HUQAN gate daemon: another daemon already listens on ${sock}`);
      process.exitCode = 1;
      return null;
    }
    fs.rmSync(sock, { force: true });
  }

  let queue = Promise.resolve();
  // Sockets that have connected but not yet sent a complete request. Shutdown
  // destroys these so server.close() can run its callback; a request already
  // dispatched is left to the queue and its own socket.end.
  const idle = new Set();
  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    // Stateful decoding, matching the client: a UTF-8 character split across
    // reads must not become two U+FFFD replacements in the evaluated payload.
    socket.setEncoding('utf8');
    let buffer = '';
    idle.add(socket);
    // A client that connects and never sends a complete request must not hold
    // this connection open: server.close() waits for existing connections, so
    // one idle socket would stall a graceful shutdown. The deadline bounds it.
    const deadline = setTimeout(() => socket.destroy(), REQUEST_DEADLINE_MS);
    socket.on('close', () => { clearTimeout(deadline); idle.delete(socket); });
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
      // Dispatched: no longer idle, so shutdown must not drop it.
      idle.delete(socket);
      clearTimeout(deadline);
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
    // The identity the client compares against before it trusts an answer.
    // Written only here, where the process has already bound the socket and
    // its own environment is settled.
    writePrivate(identityPath(sock), `${JSON.stringify(evaluationIdentity())}\n`);
    writePrivate(pidPath(sock), `${process.pid}\n`);
    log.log(`HUQAN gate daemon listening on ${sock} (pid ${process.pid})`);
  });

  const shutdown = () => {
    // Drain first: an in-flight evaluation must reach its socket before the
    // process ends, or the client sees a close with no answer after it already
    // sent the request -- the case it must treat as failed closed. Idle
    // connections are dropped so close() can complete; the socket and pid files
    // go only after the server and the queue are both done.
    const finish = () => {
      if (process.platform !== 'win32') fs.rmSync(sock, { force: true });
      fs.rmSync(pidPath(sock), { force: true });
      fs.rmSync(identityPath(sock), { force: true });
      process.exit(0);
    };
    for (const socket of idle) socket.destroy();
    server.close(() => { queue.then(finish, finish); });
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


/**
 * Start the daemon in the background and wait for its socket. Returns the pid.
 * The child is detached so it outlives this call; it logs to `logPath` so an
 * operator can read why a start failed.
 */
function startDaemon({ sock = socketPath(), entry = path.join(__dirname, '..', 'bin', 'huqan-gate-hook.js'), env = process.env, waitMs = 5000 } = {}) {
  if (daemonStatus({ sock }).running) {
    return { started: false, alreadyRunning: true, pid: readPid(sock), socket: sock };
  }
  const log = logPath(sock);
  const out = openLogPrivate(log);
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
  return { started: false, alreadyRunning: false, pid: readPid(sock), socket: sock, logPath: log };
}

/**
 * Stop the daemon, but only one we can prove is ours. A pid file alone is not
 * proof: after a crash it lingers, the OS can hand the pid to an unrelated
 * process, and `isPidAlive` would then confirm a stranger. Ownership is proven
 * by a live listener on our socket; when that proof is absent, the stale files
 * are removed and no signal is sent.
 */
async function stopDaemon({ sock = socketPath(), waitMs = 3000 } = {}) {
  const pid = readPid(sock);
  const listening = await daemonListening(sock);
  if (!listening) {
    // No listener: nothing to stop. Clean the leftover state so a later start
    // is not blocked by it, and never signal a pid we cannot tie to the socket.
    if (process.platform !== 'win32') fs.rmSync(sock, { force: true });
    fs.rmSync(pidPath(sock), { force: true });
    fs.rmSync(identityPath(sock), { force: true });
    return { stopped: false, reason: isPidAlive(pid) ? 'no daemon on this socket' : 'not running' };
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


module.exports = {
  socketPath,
  pidPath,
  logPath,
  isDaemonEnabled,
  requestDaemon,
  runDaemonServer,
  startDaemon,
  stopDaemon,
  daemonStatus,
};
