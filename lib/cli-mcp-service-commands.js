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

/** POST an unsigned empty body and expect the fail-closed refusal back. */
function probeListener(url) {
  if (!url) return Promise.resolve({ listening: false });
  return new Promise((resolve) => {
    const request = http.request(url, { method: 'POST', timeout: 3000 }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let code = null;
        try { code = JSON.parse(text)?.error?.code || null; } catch (_) { /* keep null */ }
        resolve({ listening: true, failClosed: response.statusCode === 403, refusalCode: code });
      });
    });
    request.on('timeout', () => { request.destroy(); resolve({ listening: false }); });
    request.on('error', () => resolve({ listening: false }));
    request.end();
  });
}

function writePrivateKeyFile(outFile, seedBase64url, writeFile = (file, data, opts) => fs.writeFileSync(file, data, opts)) {
  try {
    writeFile(outFile, `${seedBase64url}\n`, { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error && error.code === 'EEXIST' ? 'key_file_exists' : 'key_file_write_failed' };
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
    if (args.publicKey) {
      const read = readPublicKeyFile(args.publicKey);
      if (!read.ok) return `Enrollment refused: ${read.reason}.`;
      record = { client_id: args.client, key_id: read.keyId, public_key: read.publicKeyBase64url };
    } else {
      const created = createClientKey();
      const written = writePrivateKeyFile(args.out, created.seedBase64url);
      if (!written.ok) return `Enrollment refused: ${written.reason}; no registry change was made.`;
      record = { client_id: args.client, key_id: created.keyId, public_key: created.publicKeyBase64url };
    }
    const upserted = upsertClientRecord(registryPath(dirs.stateDir), record);
    if (!upserted.ok) return `Enrollment refused: ${upserted.reason}.`;
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

module.exports = { MCP_USAGE, probeListener, readPublicKeyFile, runMcpServiceCommand, serviceDirs, writePrivateKeyFile };
