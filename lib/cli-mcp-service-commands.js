'use strict';

// The CLI `mcp` command (ADR-018 §3, #3999): the operator-facing surface of
// the protected MCP service conversion.
//
//   huqan mcp status  --name <name>   ACL readback + store check + listener probe
//   huqan mcp config  --name <name>   the agent client's MCP configuration
//   huqan mcp enroll  --name <name> --client <id> [--public-key <file>] --out <keyfile>
//   huqan mcp revoke  --name <name> --client <id> --key-id <id>
//   huqan mcp                          help
//
// A thin wrapper, the same shape as lib/cli-store-commands.js: the decisions
// live in lib/mcp/service-acl.js, lib/mcp/client-registry.js and
// lib/mcp/endpoint-pin.js. Paths are fixed, not taken from the environment:
// data lives under C:\ProgramData\huqan\mcp\<name>, the memory store's root
// is C:\ProgramData\huqan\state. `enroll` and `revoke` write the registry,
// so they refuse to run unelevated, exactly like `huqan store migrate`.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { STORE_ROOT, checkMcpServiceAcl, checkNoStoreAce, dataDirFor, serviceAccountFor } = require('./mcp/service-acl');
const { createClientKey, keyIdFromRaw } = require('./mcp/client-envelope');
const { rawPublicKeyOf, readClientRegistry, registryPath, removeClientRecord, upsertClientRecord } = require('./mcp/client-registry');
const { endpointPinPath, readEndpointPin } = require('./mcp/endpoint-pin');
const { isProcessElevated } = require('./authority/store-migrate');

const MCP_USAGE = [
  'Usage:',
  '  huqan mcp status --name <name>',
  '  huqan mcp config --name <name> [--client <id> --key-file <path>]',
  '  huqan mcp enroll --name <name> --client <id> [--public-key <file>] --out <keyfile>',
  '  huqan mcp revoke --name <name> --client <id> --key-id <id>',
].join('\n');

function serviceDirs(name) {
  const dataDir = dataDirFor(name);
  return { dataDir, stateDir: path.win32.join(dataDir, 'state'), publicDir: path.win32.join(dataDir, 'public') };
}

const LOOPBACK_HOST = '127.0.0.1';
// The one refusal an unsigned, empty request earns from the envelope check.
const UNSIGNED_REFUSAL_CODE = 'malformed';

/**
 * The loopback port a pinned endpoint URL names, or null when the URL is not
 * a plain http loopback endpoint. The status probe sends only to
 * 127.0.0.1:<integer port>: nothing read from the pin file reaches the
 * request as a host, a path or a header.
 */
function loopbackPortOf(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch (_) { return null; }
  if (parsed.protocol !== 'http:' || parsed.hostname !== LOOPBACK_HOST || parsed.username || parsed.password) return null;
  const port = Number(parsed.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** POST an unsigned empty body and expect the fail-closed refusal back. */
function probeListener(url) {
  const port = loopbackPortOf(url);
  if (port === null) return Promise.resolve({ listening: false });
  return new Promise((resolve) => {
    const request = http.request({ host: LOOPBACK_HOST, port, path: '/', method: 'POST', timeout: 3000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      // A listener that drops the connection mid-body emits `error` or
      // `aborted` on the response, never `end`: that is not a verdict.
      response.on('error', () => resolve({ listening: false }));
      response.on('aborted', () => resolve({ listening: false }));
      response.on('end', () => {
        let code = null;
        try { code = JSON.parse(text)?.error?.code || null; } catch (_) { /* keep null */ }
        resolve({ listening: true, failClosed: response.statusCode === 403 && code === UNSIGNED_REFUSAL_CODE, refusalCode: code });
      });
    });
    request.on('timeout', () => { request.destroy(); resolve({ listening: false }); });
    request.on('error', () => resolve({ listening: false }));
    request.end();
  });
}

/** A Windows system tool by absolute path: the PATH is not trusted to name it. */
function systemTool(name) {
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
}

/** The SID of the account running this process, or null. */
function currentUserSid(spawn) {
  const run = spawn(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 10000 });
  if (!run || run.error || run.status !== 0 || typeof run.stdout !== 'string') return null;
  const match = run.stdout.match(/"(S-1-5-[0-9-]+)"/);
  return match ? match[1] : null;
}

/**
 * Windows: drop inherited ACEs and grant the file to the account that wrote
 * it alone. Node's `mode` cannot express that on Windows, so without this the
 * seed would carry whatever the parent directory grants.
 */
function restrictToCurrentUser(file, spawn) {
  const sid = currentUserSid(spawn);
  if (!sid) return false;
  const run = spawn(systemTool('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`], { encoding: 'utf8', timeout: 15000 });
  return Boolean(run) && !run.error && run.status === 0;
}

/**
 * Create the signing-seed file private to the operator: exclusive create
 * (never replaces a file), mode 0o600 on POSIX, and on Windows an ACL that
 * names only the current account -- applied while the file is still empty, so
 * the seed is never on disk under a broader ACL. A file that cannot be made
 * private is removed and the write is refused.
 */
function writePrivateKeyFile(outFile, seedBase64url, deps = {}) {
  const { spawn = spawnSync, platform = process.platform } = deps;
  let descriptor = null;
  try {
    // One atomic exclusive create; every later step uses this descriptor, so
    // the path is never re-opened (no check-then-write window).
    descriptor = fs.openSync(outFile, 'wx', 0o600);
  } catch (error) {
    return { ok: false, reason: error && error.code === 'EEXIST' ? 'key_file_exists' : 'key_file_write_failed' };
  }
  try {
    if (platform === 'win32' && !restrictToCurrentUser(outFile, spawn)) {
      fs.closeSync(descriptor);
      descriptor = null;
      fs.rmSync(outFile, { force: true });
      return { ok: false, reason: 'key_file_acl_failed' };
    }
    fs.writeSync(descriptor, `${seedBase64url}\n`);
    fs.closeSync(descriptor);
    descriptor = null;
    return { ok: true };
  } catch (_) {
    try { if (descriptor !== null) fs.closeSync(descriptor); } catch (__) { /* already closed */ }
    try { fs.rmSync(outFile, { force: true }); } catch (__) { /* nothing more to undo */ }
    return { ok: false, reason: 'key_file_write_failed' };
  }
}

function readPublicKeyFile(publicKeyFile, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  try {
    const raw = rawPublicKeyOf(String(readFile(publicKeyFile)).trim());
    return raw ? { ok: true, keyId: keyIdFromRaw(raw), publicKeyBase64url: raw.toString('base64url') } : { ok: false, reason: 'public_key_invalid' };
  } catch (_) {
    return { ok: false, reason: 'public_key_unreadable' };
  }
}

function statusLines({ pin, acl, store, listener, registry }) {
  return [
    `Server ${pin.name} on ${pin.url} (workspace ${pin.workspaceId}).`,
    `State ACL: ${acl.ok ? 'verified' : `REFUSED (${acl.reason})`}.`,
    `Memory store ACE: ${store.ok ? 'none (correct)' : `PRESENT (${store.reason})`}.`,
    `Listener: ${listener.listening ? (listener.failClosed ? `fail-closed (${listener.refusalCode})` : 'ANSWERS WITHOUT AN ENVELOPE') : 'not listening'}.`,
    `Enrolled clients: ${registry.ok ? registry.clients.map((r) => `${r.client_id}/${r.key_id}`).join(', ') || 'none' : `UNREADABLE (${registry.reason})`}.`,
    `Verdict: ${acl.ok && store.ok && listener.listening && listener.failClosed && registry.ok ? 'PROTECTED' : 'NOT PROTECTED'}.`,
  ];
}

/**
 * @param {object} args parsed command args (`sub`, `name`, `client`, ...)
 * @param {object} opts CLI opts (`json` for machine-readable output)
 * @param {object} [deps] injectable collaborators for tests
 * @returns {Promise<string|object>} text for the operator, or an object under `json`
 */
async function runMcpServiceCommand(args = {}, opts = {}, deps = {}) {
  const { isElevated = isProcessElevated(), probe = probeListener, spawn, platform, resolveDirs } = deps;
  const sub = args.sub || 'help';
  if (sub === 'help' || !args.name) return MCP_USAGE;
  if (Array.isArray(args.missingOperands) && args.missingOperands.length) {
    return `Refused: ${args.missingOperands.map((flag) => `--${flag}`).join(', ')} needs a value, not another option.` + `\n${MCP_USAGE}`;
  }

  const dirs = (resolveDirs || serviceDirs)(args.name);
  const pin = readEndpointPin(endpointPinPath(dirs.publicDir));
  const serviceAccount = serviceAccountFor(args.name);

  if (sub === 'config') {
    if (!pin.ok) return opts.json ? { ok: false, reason: pin.reason } : `No usable endpoint pin: ${pin.reason}. Install the service first.`;
    const config = {
      mcpServers: {
        [pin.pin.name]: {
          command: 'huqan-mcp',
          args: ['proxy', '--url', pin.pin.url, '--client', args.client || '<enrolled-client-id>',
            '--workspace', pin.pin.workspaceId, '--key-file', args.keyFile || '<enrolled-key-file>'],
        },
      },
    };
    return opts.json ? { ok: true, pin: pin.pin, config } : JSON.stringify(config, null, 2);
  }

  if (sub === 'enroll') {
    if (!isElevated) return 'Enrollment refused: it writes the protected registry. Run "huqan mcp enroll" from an elevated shell.';
    if (!args.client || (!args.publicKey && !args.out)) return MCP_USAGE;
    if (!pin.ok) return `No usable endpoint pin: ${pin.reason}. Install the service first.`;
    let record;
    let seed = null;
    if (args.publicKey) {
      const read = readPublicKeyFile(args.publicKey);
      if (!read.ok) return `Enrollment refused: ${read.reason}.`;
      record = { client_id: args.client, key_id: read.keyId, public_key: read.publicKeyBase64url };
    } else {
      const created = createClientKey();
      seed = created.seedBase64url;
      record = { client_id: args.client, key_id: created.keyId, public_key: created.publicKeyBase64url };
    }
    const file = registryPath(dirs.stateDir);
    const upserted = upsertClientRecord(file, record);
    if (!upserted.ok) return `Enrollment refused: ${upserted.reason}; no key file was written.`;
    if (seed !== null) {
      // The seed is written last, so a refused registry write leaves no
      // orphaned key file; if the seed cannot be written the record is
      // removed again, so the registry never names a key nobody holds.
      const written = writePrivateKeyFile(args.out, seed, { spawn, platform });
      if (!written.ok) {
        const undone = removeClientRecord(file, { client_id: record.client_id, key_id: record.key_id });
        const outcome = undone.ok
          ? 'the registry change was rolled back'
          : `the registry change could NOT be rolled back (${undone.reason}): run "huqan mcp revoke" for key ${record.key_id}`;
        return `Enrollment refused: ${written.reason}; ${outcome}.`;
      }
    }
    return `Enrolled ${record.client_id} with key ${record.key_id} for ${pin.pin.name}.`
      + `${args.publicKey ? '' : ` The signing seed was written to ${args.out}.`}`;
  }

  if (sub === 'revoke') {
    if (!isElevated) return 'Revocation refused: it writes the protected registry. Run "huqan mcp revoke" from an elevated shell.';
    if (!args.client || !args.keyId) return MCP_USAGE;
    const removed = removeClientRecord(registryPath(dirs.stateDir), { client_id: args.client, key_id: args.keyId });
    if (!removed.ok) return `Revocation refused: ${removed.reason}.`;
    return `Revoked key ${args.keyId} of ${args.client}; it stops working on the next request.`;
  }

  if (sub !== 'status') return MCP_USAGE;

  const acl = checkMcpServiceAcl({
    dataDir: dirs.dataDir,
    stateDir: dirs.stateDir,
    operatorAccount: pin.ok ? pin.pin.operator : '<unset>',
    serviceAccount,
    spawn,
    platform,
  });
  const store = checkNoStoreAce({ storeRoot: STORE_ROOT, serviceAccount, spawn, platform });
  const listener = await probe(pin.ok ? pin.pin.url : '');
  const registry = readClientRegistry(registryPath(dirs.stateDir));
  const lines = statusLines({ pin: pin.ok ? pin.pin : { name: args.name, url: '?', workspaceId: '?' }, acl, store, listener, registry });
  if (opts.json) {
    return {
      ok: pin.ok && acl.ok && store.ok && listener.listening && listener.failClosed && registry.ok,
      pin: pin.pin || null, acl, store, listener, registry: registry.ok ? registry.clients : null,
      message: lines.join('\n'),
    };
  }
  return lines.join('\n');
}

module.exports = { MCP_USAGE, loopbackPortOf, probeListener, readPublicKeyFile, runMcpServiceCommand, serviceDirs, writePrivateKeyFile };
