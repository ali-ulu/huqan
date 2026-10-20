'use strict';

// Signed decisions and signed responses of the approval authority (#3860).
//
// The authority service holds the only Ed25519 private key. A decision
// envelope binds one operator decision to one action -- approval, workspace,
// tool and canonical action hash -- for a bounded time, and names the ledger
// entry that recorded it. The runtime runs as the interactive OS user and
// cannot mint one; it can only verify one against the pinned public key.
//
// Every HTTP response is signed too, over the client's random challenge and
// the request it answers (method, path, body digest). That refuses a naive
// impostor and a replayed or re-routed answer. It does not stop an impostor
// that relays a whole exchange to the real service; that case is closed where
// it matters, at the operator's code, by lib/authority/sealed-request.js.
//
// The two signatures use distinct domain prefixes, so a decision signature can
// never be presented as a response signature or the reverse.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const crypto = require('node:crypto');
const { stableStringify } = require('../hash-chain');
const { publicKeyOf, privateKeyOf } = require('./keys');

const DECISION_VERSION = 'huqan.authority.decision.v1';
// A demo authority (lib/demo-authority.js) mints envelopes under this version so
// a demonstration can show a decision without an installed authority. It is not
// a version of this protocol: isDemoDecisionEnvelope is how the runtime's
// decision guard recognises one and refuses it, and assertPayload below rejects
// it as malformed before any signature is considered.
const DEMO_DECISION_VERSION = 'huqan.authority.demo.v1';
const DECISION_DOMAIN = `${DECISION_VERSION}\n`;
const RESPONSE_DOMAIN = 'huqan.authority.response.v1\n';
// A decision is spent soon after it is made; a long-lived one is a standing
// grant nobody reviewed as such. Enforced at signing and again at verifying.
const MAX_DECISION_TTL_MS = 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
// Strict UTC instants only: Date.parse alone accepts implementation-defined
// formats, and two parsers must never disagree on a signed field.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// Canonical unpadded base64url of a 64-byte Ed25519 signature.
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const MAX_TEXT = 512;
const DECISIONS = Object.freeze(['approved', 'rejected']);
const PAYLOAD_FIELDS = Object.freeze(['v', 'approvalId', 'workspaceId', 'tool', 'actionHash', 'decision', 'reason',
  'decidedAt', 'validUntil', 'ledgerSeq', 'ledgerHash', 'operator']);
const BINDING_FIELDS = Object.freeze(['approvalId', 'workspaceId', 'tool', 'actionHash', 'decision']);
const REQUEST_FIELDS = Object.freeze(['method', 'path', 'requestDigest']);

function keyIdFor(key) {
  // An Ed25519 SPKI DER is a fixed 12-byte header followed by the 32-byte key.
  const raw = publicKeyOf(key, 'ed25519').export({ type: 'spki', format: 'der' }).subarray(-32);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function instant(value) {
  return typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
}

function boundedText(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > MAX_TEXT) {
    throw new TypeError(`${field} must be a bounded string`);
  }
}

function assertPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('payload must be an object');
  if (stableStringify(Object.keys(payload).sort()) !== stableStringify([...PAYLOAD_FIELDS].sort())) {
    throw new TypeError('payload fields differ');
  }
  if (payload.v !== DECISION_VERSION) throw new TypeError('unsupported decision version');
  for (const field of ['approvalId', 'workspaceId', 'tool', 'operator']) boundedText(payload[field], field);
  boundedText(payload.reason, 'reason', { allowEmpty: true });
  if (!DECISIONS.includes(payload.decision)) throw new TypeError('decision must be approved or rejected');
  if (!HEX64.test(payload.actionHash) || !HEX64.test(payload.ledgerHash)) throw new TypeError('hashes must be hex sha256');
  if (!Number.isInteger(payload.ledgerSeq) || payload.ledgerSeq < 0) throw new TypeError('ledgerSeq must be a non-negative integer');
  const decidedAt = instant(payload.decidedAt);
  const validUntil = instant(payload.validUntil);
  if (!Number.isFinite(decidedAt) || !Number.isFinite(validUntil)) throw new TypeError('decidedAt and validUntil must be UTC instants');
  if (validUntil <= decidedAt || validUntil - decidedAt > MAX_DECISION_TTL_MS) throw new TypeError('validity window out of bounds');
}

function signDomain(domain, value, privateKey) {
  return crypto.sign(null, Buffer.from(domain + stableStringify(value), 'utf8'), privateKeyOf(privateKey, 'ed25519'))
    .toString('base64url');
}

function verifyDomain(domain, value, sig, publicKey) {
  if (typeof sig !== 'string' || !SIGNATURE.test(sig)) return false;
  return crypto.verify(null, Buffer.from(domain + stableStringify(value), 'utf8'), publicKey, Buffer.from(sig, 'base64url'));
}

function signDecision(payload, privateKey) {
  assertPayload(payload);
  return { alg: 'Ed25519', keyId: keyIdFor(privateKeyOf(privateKey, 'ed25519')), sig: signDomain(DECISION_DOMAIN, payload, privateKey),
    payload };
}

function isDemoDecisionEnvelope(envelope) {
  return Boolean(envelope) && typeof envelope === 'object' && !Array.isArray(envelope)
    && Boolean(envelope.payload) && typeof envelope.payload === 'object'
    && envelope.payload.v === DEMO_DECISION_VERSION;
}

/**
 * @returns {{ok: true, payload: object} | {ok: false, code: string}}
 */
function verifyDecision(envelope, { publicKey, expected, now }) {
  const key = publicKeyOf(publicKey, 'ed25519');
  if (!envelope || typeof envelope !== 'object' || envelope.alg !== 'Ed25519' || typeof envelope.keyId !== 'string') {
    return { ok: false, code: 'malformed' };
  }
  try { assertPayload(envelope.payload); } catch { return { ok: false, code: 'malformed' }; }
  if (envelope.keyId !== keyIdFor(key)) return { ok: false, code: 'key_mismatch' };
  if (!verifyDomain(DECISION_DOMAIN, envelope.payload, envelope.sig, key)) return { ok: false, code: 'signature_invalid' };
  if (BINDING_FIELDS.some(field => envelope.payload[field] !== expected?.[field])) return { ok: false, code: 'binding_mismatch' };
  if (!(instant(envelope.payload.validUntil) > now)) return { ok: false, code: 'expired' };
  return { ok: true, payload: envelope.payload };
}

function requestDigestOf(body) {
  return crypto.createHash('sha256').update(body === undefined || body === null ? '' : body).digest('hex');
}

function signResponse(body, { challenge, method, path, requestDigest }, privateKey) {
  const signed = { challenge, method, path, requestDigest, body };
  return { ...signed, keyId: keyIdFor(privateKeyOf(privateKey, 'ed25519')), sig: signDomain(RESPONSE_DOMAIN, signed, privateKey) };
}

/**
 * @returns {{ok: true, body: *} | {ok: false, code: string}}
 */
function verifyResponse(response, { publicKey, challenge, method, path, requestDigest }) {
  const key = publicKeyOf(publicKey, 'ed25519');
  if (!response || typeof response !== 'object' || typeof response.keyId !== 'string' || typeof response.challenge !== 'string'
    || REQUEST_FIELDS.some(field => typeof response[field] !== 'string') || !('body' in response)) {
    return { ok: false, code: 'malformed' };
  }
  if (response.keyId !== keyIdFor(key)) return { ok: false, code: 'key_mismatch' };
  const { challenge: c, method: m, path: p, requestDigest: d, body } = response;
  if (!verifyDomain(RESPONSE_DOMAIN, { challenge: c, method: m, path: p, requestDigest: d, body }, response.sig, key)) {
    return { ok: false, code: 'signature_invalid' };
  }
  if (c !== challenge) return { ok: false, code: 'challenge_mismatch' };
  if (m !== method || p !== path || d !== requestDigest) return { ok: false, code: 'request_mismatch' };
  return { ok: true, body };
}

module.exports = {
  DECISION_VERSION,
  DEMO_DECISION_VERSION,
  isDemoDecisionEnvelope,
  MAX_DECISION_TTL_MS,
  keyIdFor,
  requestDigestOf,
  signDecision,
  verifyDecision,
  signResponse,
  verifyResponse,
};
