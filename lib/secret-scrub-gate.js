'use strict';

/**
 * AB7 — Secret Scrub Gate.
 *
 * tool-call-gate (AB2) already detects secret-looking values in tool-call
 * args (SECRET_ARGS_REVIEW_REQUIRED) but does not redact them. This module
 * reuses that same detection (hasSecretLookingValue / redactSecretValues,
 * both exported from lib/tool-call-gate.js) to scrub secret-looking values
 * out of any payload before it is persisted (approval store, dry-run
 * result, audit findings) or logged, so a detected secret never survives in
 * plain text past the point of detection.
 */

const {
  SECRET_KEY_PATTERNS,
  hasSecretLookingValue,
  redactSecretValues,
} = require('./tool-call-gate');
const { isPlainObject } = require('./is-plain-object');

const AB7_GATE_VERSION = 'AB7-v0.1.0';

// AB2's key/value detection above looks at a leaf value as a whole (e.g. a
// value shaped exactly like "Bearer <token>"), so a token pasted mid-sentence
// with no "Bearer"/"token" keyword nearby ("session token eyJ..." in a wiki
// note) never matches. A JWT is structurally recognisable on its own --
// base64url `{"` (the `eyJ` prefix) followed by two more dot-separated
// base64url segments -- so it is detected as a substring, independent of any
// surrounding keyword or header framing.
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function hasStructuralSecret(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    JWT_PATTERN.lastIndex = 0;
    return JWT_PATTERN.test(value);
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
  }
  if (Array.isArray(value)) return value.some((item) => hasStructuralSecret(item, seen));
  if (isPlainObject(value)) return Object.values(value).some((item) => hasStructuralSecret(item, seen));
  return false;
}

function redactStructuralSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') return value.replace(JWT_PATTERN, '[REDACTED_SECRET:jwt]');
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactStructuralSecrets(item, seen));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, nested] of Object.entries(value)) out[key] = redactStructuralSecrets(nested, seen);
    return out;
  }
  return value;
}

/**
 * Scrubs secret-looking values out of `payload` and reports whether
 * anything was redacted, so callers can record that AB7 scrubbing applied
 * (e.g. in gate metadata) without needing to diff the payload themselves.
 */
function scrubSecrets(payload) {
  const keywordSecretDetected = hasSecretLookingValue(payload);
  const structuralSecretDetected = hasStructuralSecret(payload);
  const secretDetected = keywordSecretDetected || structuralSecretDetected;

  let scrubbed = payload;
  if (keywordSecretDetected) scrubbed = redactSecretValues(scrubbed);
  if (structuralSecretDetected) scrubbed = redactStructuralSecrets(scrubbed);

  return {
    scrubbed,
    secretDetected,
    gateVersion: AB7_GATE_VERSION,
  };
}

module.exports = {
  AB7_GATE_VERSION,
  SECRET_KEY_PATTERNS,
  scrubSecrets,
};
