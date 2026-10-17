'use strict';

// A persistent MCP stdio client for the upstream Laya decision server
// (#3974).
//
// Laya ships `laya-mcp-server`, a stdio MCP server whose `laya_predict` tool
// answers typed `choice`/`score`/`noul` questions in one forward pass. The
// plugin that consumes it (plugins/laya-risk.js) runs on the *synchronous*
// gate seam -- lib/gate-signal-provider.js calls `gateSignal` and treats a
// promise as a failure -- so the client must answer synchronously.
//
// A one-shot `spawnSync` session cannot. The Python MCP SDK cancels in-flight
// request handlers when stdin reaches EOF, so a `tools/call` written after
// `initialize` in the same one-shot session is dropped before its response is
// written. Measured against `mcp` 2.x: the `initialize` reply arrives, the
// `tools/call` reply never does. Holding stdin open fixes it.
//
// So this client keeps one child alive: `initialize` once, then one
// `tools/call` per gate reading. The child's stdout goes to a private temp
// file read back synchronously with the public `fs` API, so the gate path
// never awaits the event loop. The warm model answers in single-digit
// milliseconds after the handshake.
//
// Fail-closed by construction: a missing binary, a handshake that never
// completes, a non-zero exit, a JSON-RPC error, an `isError` tool result, an
// oversized output and an explicit timeout all yield no reading. The plugin
// then contributes nothing and never downgrades a core decision.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'huqan-laya-bridge';
const CLIENT_VERSION = '0.1.0';

// Bounds. The gate seam is synchronous, so an unbounded wait would block it
// for as long as the child lives (#3973). A local CPU model answers well
// inside the default window; anything slower is degraded, not merely slow.
//
// The handshake defaults to the same window as one call, so a single knob
// bounds the whole synchronous path; a cold model load can be given more room
// with LAYA_MCP_HANDSHAKE_TIMEOUT_MS.
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 5;

// A synchronous sleep. The gate seam has no event loop to yield to, so the
// wait for a reply is a bounded busy-wait -- the shape the synchronous gate
// path already has. Shared across calls: `Atomics.wait` needs an Int32Array,
// and the value is never touched.
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function envValue(name, environment) {
  const raw = environment[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

function positiveIntegerEnv(name, fallback, environment) {
  const raw = envValue(name, environment);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class LayaMcpClient {
  constructor(options = {}) {
    const environment = options.environment || process.env;
    this._command = options.command || envValue('LAYA_MCP_CMD', environment) || 'laya-mcp-server';
    const argTemplate = Array.isArray(options.args)
      ? options.args.join(' ')
      : envValue('LAYA_MCP_ARGS', environment);
    this._args = argTemplate ? argTemplate.split(/\s+/).filter(Boolean) : [];
    this._requestTimeoutMs = options.requestTimeoutMs
      || positiveIntegerEnv('LAYA_MCP_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, environment);
    this._handshakeTimeoutMs = options.handshakeTimeoutMs
      || positiveIntegerEnv('LAYA_MCP_HANDSHAKE_TIMEOUT_MS', this._requestTimeoutMs, environment);
    this._maxOutputBytes = options.maxOutputBytes
      || positiveIntegerEnv('LAYA_MCP_MAX_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES, environment);
    this._protocolVersion = options.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    this._nextId = 1;
    this._child = null;
    this._sink = null;
    this._readOffset = 0;
    this._pending = '';
    this._started = false;
    this._unavailableReason = '';
    this._lastError = '';
    this._closed = false;
  }

  /** Whether a handshake completed and the child is still running. */
  get available() {
    // A child killed by a signal has `exitCode === null` and `signalCode` set,
    // so both must be clear before the session counts as alive.
    return this._started && !this._closed
      && Boolean(this._child)
      && this._child.exitCode === null
      && this._child.signalCode === null;
  }

  /** A bounded, human-readable report of whether the bridge can answer. */
  status() {
    return {
      available: this.available,
      reason: this._unavailableReason
        || this._lastError
        || (this.available ? 'ready' : (this._closed ? 'closed' : 'not_started')),
      command: this._command,
    };
  }

  /**
   * Record a failure that ends this client's usefulness (a bad start, a closed
   * stream) and return null. Sticky: `status()` keeps reporting it.
   */
  _unavailable(reason) {
    if (!this._unavailableReason) this._unavailableReason = reason;
    return null;
  }

  /**
   * Record a per-call failure (a timeout, a JSON-RPC error) and return null.
   *
   * Deliberately not sticky: one slow answer must not make `status()` report a
   * degraded bridge forever, or a sidecar that recovers would still read as
   * down. `status()` surfaces the most recent one until the next success.
   */
  _fail(reason) {
    this._lastError = reason;
    return null;
  }

  /** Start the child and complete the MCP handshake. Idempotent per process. */
  start() {
    if (this._started) return this.available;
    this._started = true;
    if (this._closed) return this._unavailable('closed');

    let child;
    let sink;
    try {
      sink = this._createOutputSink();
      const outFd = fs.openSync(sink.file, 'a+');
      child = spawn(this._command, this._args, { stdio: ['pipe', outFd, 'pipe'] });
      // Attach before anything else: a failed `spawn` (ENOENT) emits 'error'
      // asynchronously, and an unhandled 'error' event crashes the host.
      child.on('error', () => { this._child = null; });
      // The child owns the descriptor now; the parent keeps only the path.
      fs.closeSync(outFd);
    } catch (_) {
      if (sink) this._removeSink(sink);
      return this._unavailable('spawn_failed');
    }
    // A failed `spawn` (ENOENT) leaves `pid` undefined synchronously; its
    // asynchronous `error` event cannot reach us while the gate path is
    // parked, so this is the only place the failure is observable.
    if (child.pid === undefined) {
      this._removeSink(sink);
      return this._unavailable('command_not_found');
    }

    this._child = child;
    this._sink = sink;
    this._readOffset = 0;
    this._pending = '';
    // stderr is drained so a chatty child cannot fill its pipe and block.
    if (child.stderr && typeof child.stderr.resume === 'function') child.stderr.resume();
    // The child is a warm cache, not a reason to keep the host process alive.
    // `unref()` on the child alone is not enough: the stdio pipes it holds open
    // are what keeps the event loop alive, so they must be unref'd too.
    if (typeof child.unref === 'function') child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream && typeof stream.unref === 'function') stream.unref();
    }

    const init = this._exchange({
      jsonrpc: '2.0', id: this._nextId++, method: 'initialize',
      params: {
        protocolVersion: this._protocolVersion,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    }, this._handshakeTimeoutMs);
    if (!init || !init.result) {
      this._teardown();
      return this._unavailable('handshake_failed');
    }
    this._notify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    this._unavailableReason = '';
    return true;
  }

  /**
   * Call one MCP tool and return its parsed JSON payload, or null.
   *
   * A Laya tool returns its payload as a JSON string in `content[0].text`;
   * `isError: true` is the server's own failure channel and is a degraded
   * model, not a reading.
   */
  callTool(name, args, timeoutMs = this._requestTimeoutMs) {
    if (!this.available) return this._unavailable(this._started ? 'session_lost' : 'not_started');
    const response = this._exchange({
      jsonrpc: '2.0', id: this._nextId++, method: 'tools/call',
      params: { name, arguments: args },
    }, timeoutMs);
    if (!response || response.error) return this._fail('tool_error');
    const result = response.result;
    if (!result || result.isError === true) return this._fail('tool_error');
    const text = result.content && result.content[0] && result.content[0].text;
    if (typeof text !== 'string' || !text.trim()) return this._fail('empty_result');
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return this._fail('malformed_result');
      this._lastError = '';
      return parsed;
    } catch (_) {
      return this._fail('malformed_result');
    }
  }

  close() {
    this._closed = true;
    this._teardown();
  }

  _teardown() {
    if (this._child) {
      try { this._child.stdin.end(); } catch (_) {}
      try { this._child.kill('SIGKILL'); } catch (_) {}
      this._child = null;
    }
    if (this._sink) {
      this._removeSink(this._sink);
      this._sink = null;
    }
  }

  /**
   * A private directory whose `stdout.log` receives the child's stdout.
   *
   * Redirecting stdout to a file, rather than reading the pipe stream, is what
   * keeps the read synchronous: `fs.readSync` on the file needs no event loop,
   * and the public `fs` API is enough.
   */
  _createOutputSink() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-laya-mcp-'));
    return { dir, file: path.join(dir, 'stdout.log') };
  }

  _removeSink(sink) {
    try { fs.rmSync(sink.dir, { recursive: true, force: true }); } catch (_) {}
  }

  _notify(message) {
    try { this._child.stdin.write(JSON.stringify(message) + '\n'); } catch (_) {}
  }

  /** Write one request and read its matching response, or null on any bound. */
  _exchange(message, timeoutMs) {
    if (!this._child) return null;
    try {
      this._child.stdin.write(JSON.stringify(message) + '\n');
    } catch (_) {
      return this._unavailable('write_failed');
    }
    return this._awaitResponse(message.id, timeoutMs);
  }

  _awaitResponse(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = this._nextLine();
      if (line === null) return null;            // hard failure, already recorded
      if (line === undefined) { sleepSync(POLL_INTERVAL_MS); continue; }
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      if (message && message.id === id) return message;
    }
    return this._fail('request_timeout');
  }

  /**
   * One newline-delimited frame from the child's stdout.
   *
   * Returns the line, `undefined` when no complete frame has arrived yet, and
   * `null` on a hard failure (the stream closed, or the byte cap was exceeded
   * -- recorded through `_unavailable`). The cap is checked before parsing so
   * an unbounded child cannot grow this buffer without limit (#3973).
   */
  _nextLine() {
    const newline = this._pending.indexOf('\n');
    if (newline >= 0) {
      const line = this._pending.slice(0, newline);
      this._pending = this._pending.slice(newline + 1);
      return line;
    }
    if (this._readOffset > this._maxOutputBytes) return this._unavailable('output_too_large');
    this._pump();
    const next = this._pending.indexOf('\n');
    if (next < 0) return undefined;
    const line = this._pending.slice(0, next);
    this._pending = this._pending.slice(next + 1);
    return line;
  }

  /** Append whatever the child has written since the last read. */
  _pump() {
    if (!this._sink) return;
    let size;
    try { size = fs.statSync(this._sink.file).size; } catch (_) { return; }
    if (size <= this._readOffset) return;
    const length = size - this._readOffset;
    const buffer = Buffer.alloc(length);
    let fd;
    try {
      fd = fs.openSync(this._sink.file, 'r');
      fs.readSync(fd, buffer, 0, length, this._readOffset);
    } catch (_) {
      return;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    }
    this._readOffset = size;
    this._pending += buffer.toString('utf8');
  }
}

module.exports = { LayaMcpClient, DEFAULT_PROTOCOL_VERSION, CLIENT_NAME, CLIENT_VERSION };
