'use strict';

// A clearly labelled stand-in for the approval authority (#4104).
//
// `npm run demo:agent-brake` has to show an operator decision on a machine that
// has no authority installed (ADR-016). The real authority is an OS service
// holding the only signing key and the operator's TOTP secret; the demo runs as
// the interactive user and can hold neither. So this module mints a decision
// the same way a *demonstration* can -- with a key it just generated in this
// process -- and labels every envelope it produces as a demo envelope
// (`huqan.authority.demo.v1`).
//
// That label is the whole safety story, and it is enforced outside this module:
// the runtime's decision guard refuses a demo envelope outright
// (DEMO_AUTHORITY_REFUSED, lib/authority/decision-guard.js), and
// verifyDecision() rejects it as malformed before any signature is considered.
// verifyDemoDecision() below refuses a real envelope in the other direction, so
// neither side can be mistaken for the other. Keeping the TOTP check and the
// replay/lockout rules identical to the real operator check means the demo
// refuses a wrong, malformed or replayed code exactly as the service would.

const crypto = require('node:crypto');
const { stableStringify } = require('./hash-chain');
const { DEMO_DECISION_VERSION, isDemoDecisionEnvelope, keyIdFor } = require('./authority/decision-envelope');
const { checkOperatorCode } = require('./authority/operator-check');
const { TOTP_STEP_SECONDS, base32Encode, generateTotpSecret, otpauthUri, totpAt } = require('./authority/totp');

const DEMO_AUTHORITY_LABEL = 'demo authority (in-process key, no OS boundary)';
const DEMO_DOMAIN = `${DEMO_DECISION_VERSION}\n`;
const DECISION_TTL_MS = 10 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const DECISIONS = Object.freeze(['approved', 'rejected']);
const MAX_TEXT = 512;
const PAYLOAD_FIELDS = Object.freeze(['v', 'approvalId', 'workspaceId', 'tool', 'actionHash', 'decision', 'reason',
  'decidedAt', 'validUntil', 'operator']);
const BINDING_FIELDS = Object.freeze(['approvalId', 'workspaceId', 'tool', 'actionHash', 'decision']);

function boundedText(value, field) {
  if (typeof value !== 'string' || !value || value.length > MAX_TEXT) throw new TypeError(`${field} must be a bounded string`);
  return value;
}

function assertPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('payload must be an object');
  if (stableStringify(Object.keys(payload).sort()) !== stableStringify([...PAYLOAD_FIELDS].sort())) {
    throw new TypeError('payload fields differ');
  }
  if (payload.v !== DEMO_DECISION_VERSION) throw new TypeError('not a demo decision');
  for (const field of ['approvalId', 'workspaceId', 'tool', 'operator']) boundedText(payload[field], field);
  if (typeof payload.reason !== 'string' || payload.reason.length > MAX_TEXT) throw new TypeError('reason must be a bounded string');
  if (!DECISIONS.includes(payload.decision)) throw new TypeError('decision must be approved or rejected');
  if (!HEX64.test(payload.actionHash)) throw new TypeError('actionHash must be hex sha256');
  for (const field of ['decidedAt', 'validUntil']) {
    if (typeof payload[field] !== 'string' || !Number.isFinite(Date.parse(payload[field]))) {
      throw new TypeError(`${field} must be a UTC instant`);
    }
  }
}

function signatureOf(payload, privateKey) {
  return crypto.sign(null, Buffer.from(DEMO_DOMAIN + stableStringify(payload), 'utf8'), privateKey).toString('base64url');
}

/**
 * Mint demo decisions. One instance is one operator's session: the TOTP
 * progress (last used counter, failures, lockout) lives here, exactly as the
 * authority service persists it.
 */
function createDemoAuthority({ now = () => Date.now(), operator = 'demo-operator' } = {}) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const secret = generateTotpSecret();
  let progress = { lastCounter: -1, failures: [], lockedUntil: null };

  return Object.freeze({
    label: DEMO_AUTHORITY_LABEL,
    publicKey: keys.publicKey,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: keyIdFor(keys.publicKey),
    secretBase32: base32Encode(secret),
    otpauthUri: otpauthUri({ secret, account: operator, issuer: 'HUQAN demo' }),
    /** The code the operator's phone would show at `at`; the demo prints it. */
    codeAt(at = now()) {
      return totpAt(secret, Math.floor(at / 1000 / TOTP_STEP_SECONDS));
    },
    /**
     * @returns {{ok: true, envelope: object} | {ok: false, code: string}}
     */
    decide({ approvalId, workspaceId, tool, actionHash, decision = 'approved', reason = '', code, at = now() }) {
      const checked = checkOperatorCode({ secret, code, now: at, progress });
      // The service persists the attempt before acting on it, so a failed guess
      // is never free. The in-memory copy keeps that ordering.
      progress = checked.progress;
      if (!checked.ok) return { ok: false, code: checked.code };
      const decidedAt = new Date(at).toISOString();
      const payload = { v: DEMO_DECISION_VERSION, approvalId, workspaceId, tool, actionHash, decision, reason,
        decidedAt, validUntil: new Date(at + DECISION_TTL_MS).toISOString(), operator };
      try {
        assertPayload(payload);
      } catch (error) {
        return { ok: false, code: 'malformed', message: String(error.message) };
      }
      return { ok: true, envelope: { alg: 'Ed25519', keyId: keyIdFor(keys.publicKey), sig: signatureOf(payload, keys.privateKey), payload } };
    },
  });
}

/**
 * Check a demo decision the way the demo checks its own work. Refuses a real
 * authority's envelope, so a demo can never be run past a real decision and
 * claim the credit.
 *
 * @returns {{ok: true, payload: object} | {ok: false, code: string}}
 */
function verifyDemoDecision(envelope, { publicKey, expected, now }) {
  if (!isDemoDecisionEnvelope(envelope)) return { ok: false, code: 'not_demo_decision' };
  try {
    assertPayload(envelope.payload);
  } catch {
    return { ok: false, code: 'malformed' };
  }
  if (envelope.alg !== 'Ed25519' || envelope.keyId !== keyIdFor(publicKey)) return { ok: false, code: 'key_mismatch' };
  let signatureValid = false;
  try {
    signatureValid = crypto.verify(null, Buffer.from(DEMO_DOMAIN + stableStringify(envelope.payload), 'utf8'), publicKey,
      Buffer.from(envelope.sig, 'base64url'));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, code: 'signature_invalid' };
  if (BINDING_FIELDS.some(field => envelope.payload[field] !== expected?.[field])) return { ok: false, code: 'binding_mismatch' };
  if (!(Date.parse(envelope.payload.validUntil) > now)) return { ok: false, code: 'expired' };
  return { ok: true, payload: envelope.payload };
}

module.exports = Object.freeze({
  DEMO_AUTHORITY_LABEL,
  DEMO_DECISION_VERSION,
  DECISION_TTL_MS,
  createDemoAuthority,
  verifyDemoDecision,
});
