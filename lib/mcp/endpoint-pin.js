'use strict';

// The endpoint pin of a protected MCP server (ADR-018 §3, #3999): the one
// small file the operator's install writes and every client-side surface
// trusts. Like the authority's pin (lib/authority/authority-pin.js), paths
// are fixed and the pin is written once with the exclusive `wx` flag -- an
// init that runs twice refuses rather than overwriting what the runtime
// already points at.
//
//   public\endpoint.json = {
//     v:              'huqan.mcp.endpoint.v1',
//     name:           the server's short name (huqan-mcp-<name>),
//     port:           the fixed loopback port the service listens on,
//     operator:       the account the installer granted on the state tree,
//     workspaceId:    the 16-hex id of the workspace the server serves,
//     url:            'http://127.0.0.1:<port>'
//   }
//
// The workspace id comes from lib/protected-store-path.js (first 16 hex of
// sha256 of the lowercased canonical realpath), the same id the envelope's
// workspace_id binding is checked against.

const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT_VERSION = 'huqan.mcp.endpoint.v1';
const ENDPOINT_FILENAME = 'endpoint.json';
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const WORKSPACE_ID = /^[0-9a-f]{16}$/;
const PRINCIPAL = /^[A-Za-z0-9\-. \\]{1,128}$/;

function endpointPinPath(publicDir) {
  return path.join(publicDir, ENDPOINT_FILENAME);
}

/**
 * Write the pin once. Refuses an existing pin, an out-of-range port, a name
 * that does not fit the service-name shape, or a workspace id that is not
 * 16 lowercase hex characters.
 *
 * @returns {{ok: true, pin: object, pinPath: string} | {ok: false, reason: string}}
 */
function writeEndpointPin(publicDir, { name, port, operator, workspaceId }, writeFile = (file, data, opts) => fs.writeFileSync(file, data, opts)) {
  if (!SERVICE_NAME.test(String(name || ''))) return { ok: false, reason: 'name_invalid' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'port_invalid' };
  if (!PRINCIPAL.test(String(operator || ''))) return { ok: false, reason: 'operator_invalid' };
  if (!WORKSPACE_ID.test(String(workspaceId || ''))) return { ok: false, reason: 'workspace_id_invalid' };
  const pin = { v: ENDPOINT_VERSION, name, port, operator, workspaceId, url: `http://127.0.0.1:${port}` };
  const pinPath = endpointPinPath(publicDir);
  try {
    writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') return { ok: false, reason: 'pin_exists' };
    return { ok: false, reason: 'pin_write_failed' };
  }
  return { ok: true, pin, pinPath };
}

/**
 * Read and shape-check the pin. Anything short of a well-formed pin is
 * not-ok -- a caller never falls back to guessing the port or the workspace.
 *
 * @returns {{ok: true, pin: object} | {ok: false, reason: string}}
 */
function readEndpointPin(pinPath, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  let text;
  try {
    text = readFile(pinPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, reason: 'pin_absent' };
    return { ok: false, reason: 'pin_unreadable' };
  }
  let pin;
  try {
    pin = JSON.parse(text);
  } catch (_) {
    return { ok: false, reason: 'pin_malformed' };
  }
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)
    || pin.v !== ENDPOINT_VERSION
    || !SERVICE_NAME.test(String(pin.name || ''))
    || !Number.isInteger(pin.port) || pin.port < 1 || pin.port > 65535
    || !PRINCIPAL.test(String(pin.operator || ''))
    || !WORKSPACE_ID.test(String(pin.workspaceId || ''))
    || pin.url !== `http://127.0.0.1:${pin.port}`) {
    return { ok: false, reason: 'pin_malformed' };
  }
  return { ok: true, pin };
}

module.exports = {
  ENDPOINT_FILENAME,
  ENDPOINT_VERSION,
  SERVICE_NAME,
  endpointPinPath,
  readEndpointPin,
  writeEndpointPin,
};
