'use strict';

// The enrolled-client registry for a protected MCP server (ADR-018 §3/§4,
// #3999). The operator enrols, for each agent client, the public key that
// client signs envelopes with (docs/mcp-client-envelope-spec.md §5).
//
// The registry is one JSON file in the server's protected state directory,
// written only by the elevated operator CLI (`huqan mcp enroll` / `revoke`)
// and read by the service on every boot. The rules the spec fixes are
// enforced here at enrolment time, so a bad record never reaches a verifier:
//
//   - key_id is derived from public_key; a record whose key_id disagrees is
//     rejected, not stored;
//   - a client_id holds at most two records -- the active key and the one
//     previous key during a rotation overlap no longer than the freshness
//     window;
//   - a key_id is never reused, so an envelope cannot outlive a revocation
//     by being re-enrolled under the same id.
//
// Fail-closed: a registry that cannot be read is not an empty registry that
// happens to work -- it reports not-ok and the service treats it as "no
// client is enrolled", refusing every envelope with unknown_key until the
// operator repairs it.

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_VERSION = 'huqan.mcp.client-registry.v1';
const REGISTRY_FILENAME = 'clients.json';
const MAX_TEXT_BYTES = 512;
const B64URL_RAW_KEY = /^[A-Za-z0-9_-]{43}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const MAX_RECORDS_PER_CLIENT = 2;

function boundedText(value, { allowEmpty = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
}

/** The 32-byte raw public key behind a registry record's base64url text. */
function rawPublicKeyOf(publicKeyBase64url) {
  if (typeof publicKeyBase64url !== 'string' || !B64URL_RAW_KEY.test(publicKeyBase64url)) return null;
  return Buffer.from(publicKeyBase64url, 'base64url');
}

/**
 * Validate one enrolment record against spec §5. Returns an error string or
 * null when the record is well-formed and self-consistent.
 */
function enrolmentRecordError(record, { keyIdFromRaw } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'record_malformed';
  if (Object.keys(record).sort().join(',') !== 'client_id,key_id,public_key') return 'record_fields';
  if (!boundedText(record.client_id)) return 'client_id_invalid';
  if (!HEX16.test(String(record.key_id))) return 'key_id_invalid';
  const raw = rawPublicKeyOf(record.public_key);
  if (!raw) return 'public_key_invalid';
  const derive = keyIdFromRaw || ((bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex').slice(0, 16));
  if (derive(raw) !== record.key_id) return 'key_id_mismatch';
  return null;
}

/**
 * Read and shape-check the registry file. An absent file is a valid empty
 * registry: nothing is enrolled, so every envelope fails unknown_key -- the
 * fail-closed answer, not an error. Unreadable or malformed is not-ok.
 *
 * @returns {{ok: true, clients: Array} | {ok: false, reason: string}}
 */
function readClientRegistry(file, readFile = (name) => fs.readFileSync(name, 'utf8')) {
  let text;
  try {
    text = readFile(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, clients: [] };
    return { ok: false, reason: 'registry_unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return { ok: false, reason: 'registry_malformed' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== REGISTRY_VERSION
    || !Array.isArray(parsed.clients)) {
    return { ok: false, reason: 'registry_malformed' };
  }
  for (const record of parsed.clients) {
    if (enrolmentRecordError(record) !== null) return { ok: false, reason: 'registry_malformed' };
  }
  return { ok: true, clients: parsed.clients };
}

/**
 * Insert or replace one enrolment record, enforcing the rotation rules.
 * Writes atomically (temp file plus rename in the same directory) so a
 * crashed enrolment cannot leave a half-written registry behind.
 *
 * @returns {{ok: true, clients: Array} | {ok: false, reason: string}}
 */
function upsertClientRecord(file, record, deps = {}) {
  const { readFile, writeFile = (name, data) => fs.writeFileSync(name, data), rename = (from, to) => fs.renameSync(from, to), keyIdFromRaw } = deps;
  const error = enrolmentRecordError(record, { keyIdFromRaw });
  if (error) return { ok: false, reason: error };
  const current = readFile ? readClientRegistry(file, readFile) : readClientRegistry(file);
  if (!current.ok) return current;
  if (current.clients.some((existing) => existing.key_id === record.key_id)) {
    return { ok: false, reason: 'key_id_reused' };
  }
  const sameClient = current.clients.filter((existing) => existing.client_id === record.client_id);
  if (sameClient.length >= MAX_RECORDS_PER_CLIENT) {
    return { ok: false, reason: 'rotation_overlap_full' };
  }
  const clients = [...current.clients.filter((existing) => existing.key_id !== record.key_id), record];
  const body = `${JSON.stringify({ v: REGISTRY_VERSION, clients }, null, 2)}\n`;
  try {
    const temp = `${file}.enrolling-${process.pid}`;
    writeFile(temp, body);
    rename(temp, file);
  } catch (_) {
    return { ok: false, reason: 'registry_write_failed' };
  }
  return { ok: true, clients };
}

/**
 * Remove one record (revocation, or the tail of a rotation). Takes effect on
 * the next request because the verifier reads the live registry.
 *
 * @returns {{ok: true, clients: Array} | {ok: false, reason: string}}
 */
function removeClientRecord(file, { client_id, key_id }, deps = {}) {
  const { readFile, writeFile = (name, data) => fs.writeFileSync(name, data), rename = (from, to) => fs.renameSync(from, to) } = deps;
  const current = readFile ? readClientRegistry(file, readFile) : readClientRegistry(file);
  if (!current.ok) return current;
  const clients = current.clients.filter((existing) => !(existing.client_id === client_id && existing.key_id === key_id));
  if (clients.length === current.clients.length) return { ok: false, reason: 'record_absent' };
  try {
    const temp = `${file}.revoking-${process.pid}`;
    writeFile(temp, `${JSON.stringify({ v: REGISTRY_VERSION, clients }, null, 2)}\n`);
    rename(temp, file);
  } catch (_) {
    return { ok: false, reason: 'registry_write_failed' };
  }
  return { ok: true, clients };
}

function registryPath(stateDir) {
  return path.join(stateDir, REGISTRY_FILENAME);
}

module.exports = {
  MAX_RECORDS_PER_CLIENT,
  REGISTRY_FILENAME,
  REGISTRY_VERSION,
  enrolmentRecordError,
  rawPublicKeyOf,
  readClientRegistry,
  registryPath,
  removeClientRecord,
  upsertClientRecord,
};
