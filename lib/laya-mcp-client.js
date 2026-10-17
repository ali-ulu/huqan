'use strict';

// An MCP stdio client for the upstream Laya decision server (#3974).
//
// Laya ships `laya-mcp-server`, a stdio MCP server whose `laya_predict` tool
// answers typed `choice`/`score`/`noul` questions in one forward pass. The
// plugin that consumes it (plugins/laya-risk.js) runs on the *synchronous*
// gate seam -- lib/gate-signal-provider.js calls `gateSignal` and treats a
// promise as a failure -- so the client must answer synchronously.
//
// The MCP handshake and a tool call are, however, an asynchronous conversation
// over two pipes. A synchronous caller cannot drive that conversation in
// process: on Linux a pipe write to a child happens to flush synchronously, but
// on Windows it does not, and a caller that parks the event loop (a bounded
// `Atomics.wait` busy-wait) leaves the second frame -- the `tools/call` --
// unflushed in the stream. Measured on Windows in #4002: the child received
// `initialize` and nothing else, so the call timed out there while it passed on
// Linux.
//
// So the conversation runs where it can: in a short-lived child of this same
// file (`node lib/laya-mcp-client.js`, the `CHILD_MODE` shape
// scripts/run-test-shard.js already uses). The helper owns a real event loop,
// does the handshake and the tool call asynchronously, and prints one JSON
// result line. The caller drives that helper with `spawnSync`, which is
// synchronous and portable, and reads the result back. No temp file, no
// `Atomics.wait`, no in-process pipe writes: nothing platform-specific is left
// on the synchronous path.
//
// Fail-closed by construction: a missing binary, a handshake that never
// completes, a non-zero exit, a JSON-RPC error, an `isError` tool result, an
// oversized output and an explicit timeout all yield no reading. The plugin
// then contributes nothing and never downgrades a core decision.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'huqan-laya-bridge';
const CLIENT_VERSION = '0.2.0';

// The helper is this file, run with this flag set so a plain `require` of the
// module never starts a server.
const HELPER_FLAG = 'HUQAN_LAYA_MCP_HELPER';

// Bounds. The gate seam is synchronous, so an unbounded wait would block it for
// as long as the sidecar lives (#3973). A local CPU model answers well inside
// the default window; anything slower is degraded, not merely slow.
//
// The helper enforces `LAYA_MCP_TIMEOUT_MS`; the caller gives it a little more
// wall-clock room so the helper's own timeout wins the race and reports a clean
// `request_timeout` instead of being killed mid-write.
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const HELPER_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

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

/**
 * Whether `command` can be launched, without launching it.
 *
 * `start()` needs to distinguish "no sidecar is installed" from "the sidecar is
 * installed but degraded", and it must do so synchronously. A path-like command
 * is checked directly; a bare name is searched on PATH, with PATHEXT on
 * Windows.
 */
function commandResolvable(command) {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return fs.existsSync(command);
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return dirs.some((dir) => extensions.some((ext) => fs.existsSync(path.join(dir, command + ext))));
}

// ── the helper: an asynchronous MCP stdio session in its own process ───────

/**
 * Run the whole MCP exchange against a fresh sidecar and return one result
 * object. Asynchronous on purpose: this is the side of the bridge that has an
 * event loop to flush pipe writes with.
 */
function exchangeWithSidecar(request) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(request.command, request.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (_) {
      resolve({ ok: false, reason: 'spawn_failed' });
      return;
    }

    let settled = false;
    const pending = new Map();
    let buffer = '';
    let nextId = 1;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch (_) {}
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'request_timeout' }), request.timeoutMs);

    child.on('error', (error) => {
      finish({ ok: false, reason: error && error.code === 'ENOENT' ? 'command_not_found' : 'spawn_failed' });
    });
    // A sidecar that dies mid-exchange, or a stdin pipe that breaks, must resolve
    // the pending `send` now instead of letting it ride out the timeout. A failed
    // spawn leaves the pipes unset, so they are guarded.
    if (child.stdin) child.stdin.on('error', () => finish({ ok: false, reason: 'write_failed' }));
    child.on('exit', () => finish({ ok: false, reason: 'sidecar_exited' }));
    if (child.stderr && typeof child.stderr.resume === 'function') child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > request.maxOutputBytes) { finish({ ok: false, reason: 'output_too_large' }); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch (_) { continue; }
        const deliver = pending.get(message.id);
        if (deliver) { pending.delete(message.id); deliver(message); }
      }
    });

    const send = (method, params) => new Promise((deliver) => {
      const id = nextId++;
      pending.set(id, deliver);
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (_) {
        finish({ ok: false, reason: 'write_failed' });
      }
    });
    const notify = (method, params) => {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      } catch (_) {
        finish({ ok: false, reason: 'write_failed' });
      }
    };

    (async () => {
      const init = await send('initialize', {
        protocolVersion: request.protocolVersion,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
      if (!init || !init.result) { finish({ ok: false, reason: 'handshake_failed' }); return; }
      notify('notifications/initialized', {});
      const response = await send('tools/call', { name: request.toolName, arguments: request.toolArgs });
      if (!response) { finish({ ok: false, reason: 'request_timeout' }); return; }
      if (response.error) { finish({ ok: false, reason: 'tool_error' }); return; }
      const result = response.result;
      if (!result || result.isError === true) { finish({ ok: false, reason: 'tool_error' }); return; }
      const text = result.content && result.content[0] && result.content[0].text;
      if (typeof text !== 'string' || !text.trim()) { finish({ ok: false, reason: 'empty_result' }); return; }
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { finish({ ok: false, reason: 'malformed_result' }); return; }
      if (!parsed || typeof parsed !== 'object') { finish({ ok: false, reason: 'malformed_result' }); return; }
      finish({ ok: true, payload: parsed });
    })();
  });
}

async function runHelper() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    request = null;
  }
  const result = request && request.command
    ? await exchangeWithSidecar(request)
    : { ok: false, reason: 'bad_request' };
  try {
    fs.writeSync(1, `${JSON.stringify(result)}\n`);
  } catch (_) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  process.exit(0);
}

// ── the caller: a synchronous facade over the helper ───────────────────────

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
    this._maxOutputBytes = options.maxOutputBytes
      || positiveIntegerEnv('LAYA_MCP_MAX_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES, environment);
    this._protocolVersion = options.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    this._started = false;
    this._closed = false;
    this._unavailableReason = '';
    this._lastError = '';
  }

  /** Whether the bridge is started, open, and able to attempt a call. */
  get available() {
    return this._started && !this._closed && !this._unavailableReason;
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
   * Record a failure that ends this client's usefulness (a missing binary) and
   * return null. Sticky: `status()` keeps reporting it.
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

  /**
   * Confirm the sidecar is installed and mark the bridge usable. Idempotent.
   *
   * No server is started here: the helper starts one per call. This step exists
   * so the plugin can tell "no sidecar is installed" (a stable, reportable
   * state) from "the sidecar ran and did not answer" (a per-call degradation).
   */
  start() {
    if (this._started) return this.available;
    this._started = true;
    if (this._closed) return this._unavailable('closed');
    if (!commandResolvable(this._command)) return this._unavailable('command_not_found');
    this._unavailableReason = '';
    return true;
  }

  /**
   * Call one MCP tool through the helper and return its parsed JSON payload, or
   * null. A Laya tool returns its payload as a JSON string in
   * `content[0].text`; `isError: true` is the server's own failure channel and
   * is a degraded model, not a reading.
   */
  callTool(name, args, timeoutMs = this._requestTimeoutMs) {
    if (this._closed) return this._unavailable('closed');
    if (!this._started) return this._unavailable('not_started');
    const request = {
      command: this._command,
      args: this._args,
      toolName: name,
      toolArgs: args,
      protocolVersion: this._protocolVersion,
      timeoutMs,
      maxOutputBytes: this._maxOutputBytes,
    };
    const run = spawnSync(process.execPath, [__filename], {
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: timeoutMs + HELPER_GRACE_MS,
      maxBuffer: Math.max(this._maxOutputBytes, 64 * 1024) + 64 * 1024,
      env: { ...process.env, [HELPER_FLAG]: '1' },
      windowsHide: true,
    });
    if (run.error) {
      return this._fail(run.error.code === 'ETIMEDOUT' ? 'request_timeout' : 'spawn_failed');
    }
    let result;
    try {
      result = JSON.parse(String(run.stdout || '').trim());
    } catch (_) {
      return this._fail('malformed_result');
    }
    if (!result || result.ok !== true) {
      const reason = result && result.reason;
      if (reason === 'command_not_found') return this._unavailable('command_not_found');
      return this._fail(reason || 'tool_error');
    }
    this._lastError = '';
    return result.payload;
  }

  close() {
    this._closed = true;
  }
}

if (process.env[HELPER_FLAG] === '1') {
  runHelper();
}

module.exports = { LayaMcpClient, DEFAULT_PROTOCOL_VERSION, CLIENT_NAME, CLIENT_VERSION };
