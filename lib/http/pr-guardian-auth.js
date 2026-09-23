'use strict';

const crypto = require('node:crypto');
const { constantTimeEqual: sharedConstantTimeEqual } = require('../../requestGuards');

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

/**
 * For the fixed-length HMAC comparison in verifySignature only.
 *
 * Both operands there are `sha256=` plus 64 hex characters, so the length check
 * describes the format rather than leaking a secret. It is deliberately not
 * used for the operator token below, whose length is secret (#1038).
 */
function constantTimeEqual(left, right) {
  const a = Buffer.from(text(left));
  const b = Buffer.from(text(right));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function operatorAuthorized(configuredToken, presentedToken) {
  if (!text(configuredToken) || !text(presentedToken)) return false;
  // The shared helper hashes both sides, so a variable-length secret's length
  // does not reach the timing of this call.
  return sharedConstantTimeEqual(text(configuredToken), text(presentedToken));
}

function verifySignature(secret, rawBody, signature) {
  if (!text(secret) || !text(signature)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEqual(expected, signature);
}

module.exports = Object.freeze({
  text,
  constantTimeEqual,
  operatorAuthorized,
  verifySignature,
});
