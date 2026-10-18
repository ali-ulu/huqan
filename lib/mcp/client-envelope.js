'use strict';

// The MCP client envelope (#3997, ADR-018 §4): the signed, single-use,
// short-lived proof every request to a protected MCP server carries before
// that server reads protected state or performs any side effect.
//
// The wire contract is docs/mcp-client-envelope-spec.md. This module is the
// production implementation of both sides:
//
//   - an agent client signs with createClientEnvelope();
//   - a protected server verifies with verifyClientEnvelope(), in the seven
//     ordered fail-closed steps of the specification, stopping at the first
//     failure and refusing with that step's code.
//
// The reference verifier lives in scripts/generate-mcp-client-envelope-vectors.js
// beside the vectors it generates; test/mcp-client-envelope.test.js runs the
// committed vectors through both implementations, so they cannot drift apart
// silently. Canonical JSON is the repository's published one (stableStringify
// in lib/hash-chain.js); the key id is the same 16-hex identifier
// lib/authority/decision-envelope.js computes, recomputed here from raw key
// bytes so this module needs nothing from the authority bundle.
//
// Fail-closed by construction: step 5 consumes the nonce through the durable
// store (lib/mcp-capability-nonce-store.js) whenever one is supplied, and a
// store that cannot record refuses the request exactly like an already
// consumed nonce -- an unavailable store must not restore replayability.
// Without a store (vectors and unit tests only) the call's consumed_nonces
// list stands in; production callers always pass the store.

const crypto = require('node:crypto');
const { stableStringify } = require('../hash-chain');

const ENVELOPE_VERSION = 'huqan.mcp.envelope.v1';
const DOMAIN = `${ENVELOPE_VERSION}\n`;
const MAX_TTL_MS = 60_000;
// Client and server run as separate processes (on Windows, with different
// clock reads), so an envelope stamped "now" can reach a verifier whose clock
// is a few milliseconds behind. This allowance applies to the not-before check
// ONLY: expiry is not extended, and the nonce store keeps a record for its
// whole sweep grace (60 s), which exceeds expires_at + this allowance.
const MAX_CLOCK_SKEW_MS = 5_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const B64URL_NONCE = /^[A-Za-z0-9_-]{22,86}$/;
const B64URL_SIG = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const B64URL_RAW_KEY = /^[A-Za-z0-9_-]{43}$/;
const FIELDS = Object.freeze(['v', 'client_id', 'workspace_id', 'op', 'args_sha256', 'nonce', 'issued_at', 'expires_at', 'key_id', 'sig']);
const MAX_TEXT_BYTES = 512;
const MIN_TTL_MS = 1;

// Ed25519 SPKI/PKCS8 fixed headers; the seed is the last 32 bytes.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Every verification code the specification defines, in step order. */
const CODES = Object.freeze(['malformed', 'unknown_key', 'signature_invalid', 'not_yet_valid', 'expired', 'replayed', 'binding_mismatch', 'args_mismatch']);

// A refusal message is fixed per code and bounded: it must never echo the
// arguments, the signature, or any key material.
const REFUSAL_MESSAGES = Object.freeze({
  malformed: 'the envelope is structurally invalid',
  unknown_key: 'the signing key is not enrolled for this client',
  signature_invalid: 'the envelope signature does not verify',
  not_yet_valid: 'the envelope is not valid yet',
  expired: 'the freshness window has closed',
  replayed: 'the nonce could not be exclusively reserved (consumed or unrecordable)',
  binding_mismatch: 'the envelope does not bind the presented call',
  args_mismatch: 'the call arguments differ from the signed args_sha256',
});

function refusalMessage(code) {
  return REFUSAL_MESSAGES[code] || 'the envelope was refused';
}

/** First 16 hex characters of sha256(raw public key) -- spec §3.1. */
function keyIdFromRaw(rawPublicKey) {
  return crypto.createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16);
}

function keyIdFor(key) {
  const privateKey = key instanceof crypto.KeyObject ? key : crypto.createPrivateKey(key);
  const raw = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  return keyIdFromRaw(raw);
}

/** Unpadded base64url of the 32-byte raw public key -- the registry form. */
function rawPublicKeyBase64url(key) {
  const privateKey = key instanceof crypto.KeyObject ? key : crypto.createPrivateKey(key);
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
}

/** Ed25519 private key from the unpadded base64url 32-byte seed files carry. */
function privateKeyFromSeed(seedBase64url) {
  if (typeof seedBase64url !== 'string' || !B64URL_RAW_KEY.test(seedBase64url)) {
    throw new TypeError('seed must be unpadded base64url of 32 bytes');
  }
  const seed = Buffer.from(seedBase64url, 'base64url');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** A fresh Ed25519 keypair for one agent client, as the registry and the key file spell it. */
function createClientKey() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url');
  return { seedBase64url: seed, privateKey, keyId: keyIdFor(privateKey), publicKeyBase64url: rawPublicKeyBase64url(privateKey) };
}

/** sha256Hex(canonicalJson(args)) over the arguments of the actual call. */
function argsSha256(args) {
  return crypto.createHash('sha256').update(stableStringify(args), 'utf8').digest('hex');
}

function instant(value) {
  return typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
}

function boundedText(value, { allowEmpty = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
}

function signEnvelope(unsigned, privateKey) {
  const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('expected an ed25519 private key');
  const sig = crypto.sign(null, Buffer.from(DOMAIN + stableStringify(unsigned), 'utf8'), key).toString('base64url');
  return { ...unsigned, sig };
}

/**
 * Build and sign one envelope for one call. A programmer error (bad field,
 * ttl out of bounds) throws; a presented envelope is never built here.
 *
 * @param {object} input
 * @param {string} input.client_id enrolled agent client identity
 * @param {string} input.workspace_id the workspace the request is bound to
 * @param {string} input.op the MCP operation name (the JSON-RPC method)
 * @param {*} input.args the arguments of the actual call
 * @param {Date|string} [input.now] issuance instant; defaults to now
 * @param {number} [input.ttlMs] freshness window, 1..60000 ms
 * @param {string} [input.nonce] single-use value; defaults to 128 fresh bits
 * @param {crypto.KeyObject|Buffer|string} privateKey the enrolled client key
 */
function createClientEnvelope(input, privateKey) {
  if (!input || typeof input !== 'object') throw new TypeError('envelope input is required');
  for (const field of ['client_id', 'workspace_id', 'op']) {
    if (!boundedText(input[field])) throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  const issuedMs = input.now instanceof Date ? input.now.getTime() : instant(input.now ?? new Date().toISOString());
  if (!Number.isFinite(issuedMs)) throw new TypeError('now must be a Date or a strict UTC instant');
  const ttl = input.ttlMs ?? MAX_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) {
    throw new TypeError(`ttlMs must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
  }
  const nonce = input.nonce ?? crypto.randomBytes(16).toString('base64url');
  if (!B64URL_NONCE.test(nonce)) throw new TypeError('nonce must be unpadded base64url of 16..64 bytes');
  const issuedAt = new Date(issuedMs).toISOString();
  const expiresAt = new Date(issuedMs + ttl).toISOString();
  return signEnvelope({
    v: ENVELOPE_VERSION,
    client_id: input.client_id,
    workspace_id: input.workspace_id,
    op: input.op,
    args_sha256: argsSha256(input.args),
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
    key_id: keyIdFor(privateKey),
  }, privateKey);
}

/**
 * The production verifier. Runs the seven ordered steps of the specification
 * against the presented call and stops at the first failure.
 *
 * @param {object} envelope the presented envelope
 * @param {object} call `{client_id, workspace_id, op, args, now}` -- the call
 *   the server is about to act on
 * @param {Array} enrolled `[{client_id, key_id, public_key}]`
 * @param {object} [options]
 * @param {{consume: (nonce: string, exp: number, now: number) => boolean}} [options.nonceStore]
 *   the durable consumed-nonce store; required in production
 * @returns {{ok: true, payload: {client_id, workspace_id, op}} | {ok: false, code: string}}
 */
function verifyClientEnvelope(envelope, call, enrolled, { nonceStore } = {}) {
  const fail = (code) => ({ ok: false, code });
  const now = instant(call && call.now);

  // 1. Structure: fields, types, bounds, version, TTL window.
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return fail('malformed');
  if (Object.keys(envelope).sort().join(',') !== [...FIELDS].sort().join(',')) return fail('malformed');
  if (envelope.v !== ENVELOPE_VERSION) return fail('malformed');
  for (const field of ['client_id', 'workspace_id', 'op']) if (!boundedText(envelope[field])) return fail('malformed');
  if (!HEX64.test(String(envelope.args_sha256))) return fail('malformed');
  if (!HEX16.test(String(envelope.key_id))) return fail('malformed');
  if (!B64URL_NONCE.test(String(envelope.nonce))) return fail('malformed');
  if (!B64URL_SIG.test(String(envelope.sig))) return fail('malformed');
  const issued = instant(envelope.issued_at);
  const expires = instant(envelope.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return fail('malformed');
  if (!(expires > issued) || expires - issued > MAX_TTL_MS) return fail('malformed');

  // 2. Known key: client_id is enrolled and key_id is that client's key.
  const records = Array.isArray(enrolled) ? enrolled.filter((r) => r && r.client_id === envelope.client_id) : [];
  if (!records.some((r) => r.key_id === envelope.key_id)) return fail('unknown_key');
  const record = records.find((r) => r.key_id === envelope.key_id);

  // 3. Signature over the domain-separated canonical envelope.
  let publicKey;
  try {
    const raw = Buffer.from(record.public_key, 'base64url');
    publicKey = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return fail('unknown_key');
  }
  const { sig, ...unsigned } = envelope;
  const verified = crypto.verify(null, Buffer.from(DOMAIN + stableStringify(unsigned), 'utf8'), publicKey, Buffer.from(sig, 'base64url'));
  if (!verified) return fail('signature_invalid');

  // 4. Freshness.
  if (!(now >= issued - MAX_CLOCK_SKEW_MS)) return fail('not_yet_valid');
  if (!(now < expires)) return fail('expired');

  // 5. Nonce replay: with the durable store, the reservation and the check
  // are one exclusive create; an unrecordable nonce refuses like a replayed
  // one. Without a store (vectors and tests) the call's consumed list stands in.
  if (nonceStore) {
    if (nonceStore.consume(envelope.nonce, Math.floor(expires / 1000), Number(now)) !== true) return fail('replayed');
  } else {
    const consumed = Array.isArray(call.consumed_nonces) ? call.consumed_nonces : [];
    if (consumed.includes(envelope.nonce)) return fail('replayed');
  }

  // 6. Binding: client, workspace and operation equal the actual call.
  if (envelope.client_id !== call.client_id || envelope.workspace_id !== call.workspace_id || envelope.op !== call.op) {
    return fail('binding_mismatch');
  }

  // 7. Arguments digest matches the actual arguments.
  if (envelope.args_sha256 !== argsSha256(call.args)) return fail('args_mismatch');

  return { ok: true, payload: { client_id: envelope.client_id, workspace_id: envelope.workspace_id, op: envelope.op } };
}

module.exports = {
  CODES,
  DOMAIN,
  ENVELOPE_VERSION,
  FIELDS,
  MAX_CLOCK_SKEW_MS,
  MAX_TTL_MS,
  REFUSAL_MESSAGES,
  argsSha256,
  createClientEnvelope,
  createClientKey,
  keyIdFor,
  keyIdFromRaw,
  privateKeyFromSeed,
  rawPublicKeyBase64url,
  refusalMessage,
  signEnvelope,
  verifyClientEnvelope,
};
