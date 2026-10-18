#!/usr/bin/env node
'use strict';

/**
 * Generate the conformance vectors for the MCP client envelope (#3997).
 *
 * The envelope is specified in docs/mcp-client-envelope-spec.md. This module is
 * its executable form: it both produces the committed vectors and carries the
 * reference verifier the vector test exercises. The specification and this
 * verifier are the two artifacts #3999 (the MCP service conversion) consumes.
 *
 * GENERATED, NOT HAND-WRITTEN. The envelope's `args_sha256` and its signature
 * are both computed over a canonical serialization, so a hand-edited vector is
 * a vector whose bytes no longer describe the format. Producing them from the
 * verifier means a positive vector is exactly what the implementation emits,
 * and each negative vector is a valid envelope corrupted in a *single* place so
 * it isolates one verification step.
 *
 * Byte-reproducible: the keys come from fixed seeds and every instant is fixed,
 * so regenerating after an unrelated change produces no diff. The vectors carry
 * public keys only -- no private key is ever written.
 *
 * Run `node scripts/generate-mcp-client-envelope-vectors.js` after any change to
 * the format; test/mcp-client-envelope-vectors.test.js fails when the committed
 * vectors no longer match what this produces.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { stableStringify } = require('../lib/hash-chain');

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
const FIELDS = Object.freeze(['v', 'client_id', 'workspace_id', 'op', 'args_sha256', 'nonce', 'issued_at', 'expires_at', 'key_id', 'sig']);
const MAX_TEXT = 512;

const OUT_DIR = path.resolve(__dirname, '..', 'test', 'fixtures', 'mcp-client-envelope');

// Ed25519 SPKI/PKCS8 fixed headers; the seed is the last 32 bytes.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privateKeyFromSeed(byte) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, byte)]), format: 'der', type: 'pkcs8' });
}

function rawPublicKey(privateKey) {
  // An Ed25519 SPKI DER is a fixed 12-byte header followed by the 32-byte key.
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
}

/** First 16 hex chars of sha256(raw public key) -- the identifier decision-envelope.js also uses. */
function keyIdFor(privateKey) {
  return crypto.createHash('sha256').update(rawPublicKey(privateKey)).digest('hex').slice(0, 16);
}

function argsSha256(args) {
  return crypto.createHash('sha256').update(stableStringify(args), 'utf8').digest('hex');
}

function signEnvelope(unsigned, privateKey) {
  const sig = crypto.sign(null, Buffer.from(DOMAIN + stableStringify(unsigned), 'utf8'), privateKey).toString('base64url');
  return { ...unsigned, sig };
}

function instant(value) {
  return typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
}

function boundedText(value, { allowEmpty = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= MAX_TEXT;
}

/**
 * The reference verifier. Runs the seven ordered steps of the specification and
 * stops at the first failure, returning `{ok: false, code}`.
 *
 * @param {object} envelope the presented envelope
 * @param {object} call `{client_id, workspace_id, op, args, now, consumed_nonces}`
 * @param {Array} enrolled `[{client_id, key_id, public_key}]`
 */
function verifyEnvelope(envelope, call, enrolled) {
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

  // 2. Known key: client_id is enrolled and key_id is that client's active key.
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

  // 5. Nonce replay.
  const consumed = Array.isArray(call.consumed_nonces) ? call.consumed_nonces : [];
  if (consumed.includes(envelope.nonce)) return fail('replayed');

  // 6. Binding: client, workspace and operation equal the actual call.
  if (envelope.client_id !== call.client_id || envelope.workspace_id !== call.workspace_id || envelope.op !== call.op) {
    return fail('binding_mismatch');
  }

  // 7. Arguments digest matches the actual arguments.
  if (envelope.args_sha256 !== argsSha256(call.args)) return fail('args_mismatch');

  return { ok: true, payload: { client_id: envelope.client_id, workspace_id: envelope.workspace_id, op: envelope.op } };
}

// --- vector construction ----------------------------------------------------

const CLIENT_ID = 'agent-claude-code';
const WORKSPACE_ID = 'default';
const OP = 'huqan.learn';
const ARGS = Object.freeze({ workspaceId: WORKSPACE_ID, statement: 'the sky is blue' });
const NONCE = Buffer.alloc(16, 0x5a).toString('base64url');
const ISSUED_AT = '2026-01-01T00:00:00.000Z';
const EXPIRES_AT = '2026-01-01T00:01:00.000Z';
const NOW = '2026-01-01T00:00:30.000Z';

const clientKey = privateKeyFromSeed(7);
const otherKey = privateKeyFromSeed(9);

const enrolled = [{ client_id: CLIENT_ID, key_id: keyIdFor(clientKey), public_key: rawPublicKey(clientKey).toString('base64url') }];

function baseUnsigned(overrides = {}) {
  return {
    v: ENVELOPE_VERSION,
    client_id: CLIENT_ID,
    workspace_id: WORKSPACE_ID,
    op: OP,
    args_sha256: argsSha256(ARGS),
    nonce: NONCE,
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    key_id: keyIdFor(clientKey),
    ...overrides,
  };
}

function call(overrides = {}) {
  return { client_id: CLIENT_ID, workspace_id: WORKSPACE_ID, op: OP, args: { ...ARGS }, now: NOW, consumed_nonces: [], ...overrides };
}

function vector(name, description, expect, envelope, callOverrides = {}, enrolledOverride = enrolled) {
  return { name, description, expect, envelope, call: call(callOverrides), enrolled: enrolledOverride };
}

function vectors() {
  const valid = signEnvelope(baseUnsigned(), clientKey);
  const out = {};

  out['valid.json'] = vector('valid', 'a correctly signed, fresh, bound envelope', { ok: true }, valid);

  // malformed: three ways the structure itself is wrong.
  out['malformed-missing-field.json'] = vector(
    'malformed-missing-field', 'the op field is absent',
    { ok: false, code: 'malformed' },
    (() => { const e = { ...valid }; delete e.op; return e; })(),
  );
  out['malformed-wrong-version.json'] = vector(
    'malformed-wrong-version', 'v names a version the verifier does not implement',
    { ok: false, code: 'malformed' },
    signEnvelope(baseUnsigned({ v: 'huqan.mcp.envelope.v2' }), clientKey),
  );
  out['malformed-ttl-too-long.json'] = vector(
    'malformed-ttl-too-long', 'the freshness window is 120 s, over the 60 s bound',
    { ok: false, code: 'malformed' },
    signEnvelope(baseUnsigned({ expires_at: '2026-01-01T00:02:00.000Z' }), clientKey),
  );

  // unknown_key: structurally valid, signed by a key that is not enrolled.
  out['unknown-key.json'] = vector(
    'unknown-key', 'the signing key_id is not enrolled for the client',
    { ok: false, code: 'unknown_key' },
    signEnvelope(baseUnsigned({ key_id: keyIdFor(otherKey) }), otherKey),
  );

  // signature_invalid: correct key, one byte of the signature flipped.
  const flipped = (() => {
    const bytes = Buffer.from(valid.sig, 'base64url');
    bytes[0] ^= 0x01;
    return { ...valid, sig: bytes.toString('base64url') };
  })();
  out['signature-invalid.json'] = vector(
    'signature-invalid', 'the signature does not verify against the enrolled key',
    { ok: false, code: 'signature_invalid' }, flipped,
  );

  // not_yet_valid / expired: signature verifies, the clock does not.
  out['not-yet-valid.json'] = vector(
    'not-yet-valid', 'the verifier clock is before issued_at by more than the allowed skew',
    { ok: false, code: 'not_yet_valid' }, valid, { now: '2025-12-31T23:59:50.000Z' },
  );
  out['expired.json'] = vector(
    'expired', 'the freshness window has closed',
    { ok: false, code: 'expired' }, valid, { now: '2026-01-01T00:01:00.000Z' },
  );

  // replayed: the nonce was already consumed.
  out['replayed.json'] = vector(
    'replayed', 'the envelope nonce is already in the consumed set',
    { ok: false, code: 'replayed' }, valid, { consumed_nonces: [NONCE] },
  );

  // binding_mismatch: a valid envelope presented for a different operation.
  out['binding-mismatch.json'] = vector(
    'binding-mismatch', 'the envelope op does not match the call',
    { ok: false, code: 'binding_mismatch' }, valid, { op: 'huqan.approve' },
  );

  // args_mismatch: a valid envelope whose args_sha256 is not the call's args.
  out['args-mismatch.json'] = vector(
    'args-mismatch', 'the call arguments differ from the signed args_sha256',
    { ok: false, code: 'args_mismatch' }, valid, { args: { workspaceId: WORKSPACE_ID, statement: 'the sky is green' } },
  );

  return out;
}

/** Every verification code the specification defines; the vector test pins this set. */
const CODES = Object.freeze(['malformed', 'unknown_key', 'signature_invalid', 'not_yet_valid', 'expired', 'replayed', 'binding_mismatch', 'args_mismatch']);

function write() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, value] of Object.entries(vectors())) {
    fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  return OUT_DIR;
}

if (require.main === module) {
  const dir = write();
  process.stdout.write(`wrote ${Object.keys(vectors()).length} MCP client envelope vectors to ${path.relative(process.cwd(), dir)}\n`);
}

module.exports = { MAX_CLOCK_SKEW_MS, vectors, write, verifyEnvelope, argsSha256, keyIdFor, signEnvelope, CODES, OUT_DIR, ENVELOPE_VERSION };
