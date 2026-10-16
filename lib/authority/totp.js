'use strict';

// TOTP (RFC 6238 over RFC 4226 HOTP, HMAC-SHA1, 30 s step, 6 digits) for the
// approval authority's operator check (#3860).
//
// The secret lives only in the authority service's protected state and in the
// operator's authenticator app, so a code proves the operator is present in a
// way code running as the interactive OS user cannot reproduce. A code is
// accepted once: the caller persists the returned counter and passes it back
// as `lastCounter`, and any code at or before it is a replay. That also means
// at most one decision per step, which is a human pace anyway.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js): node:
// builtins only.

const crypto = require('node:crypto');

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;
// RFC 4226 section 4 requires at least 128 bits of shared secret.
const MIN_SECRET_BYTES = 16;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_PATTERN = /^\d{6}$/;

function generateTotpSecret() {
  return crypto.randomBytes(SECRET_BYTES);
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Unpadded RFC 4648 lengths: a remainder of 1, 3 or 6 characters cannot come
// from whole bytes, and the bits left over after the last byte must be zero.
const INVALID_REMAINDERS = Object.freeze([1, 3, 6]);

function base32Decode(text) {
  const normalized = String(text).toUpperCase().replace(/=+$/, '');
  if (!normalized || INVALID_REMAINDERS.includes(normalized.length % 8)) throw new TypeError('not a whole-byte base32 string');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new TypeError(`not a base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if ((value & ((1 << bits) - 1)) !== 0) throw new TypeError('base32 string has non-zero trailing bits');
  return Buffer.from(bytes);
}

// encodeURIComponent rather than URLSearchParams: the latter writes a space as
// `+`, which several authenticator apps show literally in the issuer.
function otpauthUri({ secret, account, issuer }) {
  const params = { secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS) };
  const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${query}`;
}

function totpAt(secret, counter, digits = TOTP_DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function sameCode(a, b) {
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * @returns {{ok: true, counter: number} | {ok: false, reason: 'malformed'|'invalid'|'replayed'}}
 */
function verifyTotp({ secret, code, now, lastCounter = -1, window = 1 }) {
  if (!Buffer.isBuffer(secret) || secret.length < MIN_SECRET_BYTES || typeof code !== 'string' || !CODE_PATTERN.test(code)
    || !Number.isFinite(now) || !Number.isInteger(lastCounter) || !Number.isInteger(window) || window < 0) {
    return { ok: false, reason: 'malformed' };
  }
  const current = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  // Every candidate step is computed, so the time taken does not reveal which
  // step (if any) matched.
  let matched = null;
  for (let counter = current - window; counter <= current + window; counter += 1) {
    if (counter >= 0 && sameCode(totpAt(secret, counter), code) && matched === null) matched = counter;
  }
  if (matched === null) return { ok: false, reason: 'invalid' };
  if (matched <= lastCounter) return { ok: false, reason: 'replayed' };
  return { ok: true, counter: matched };
}

module.exports = {
  TOTP_STEP_SECONDS,
  TOTP_DIGITS,
  generateTotpSecret,
  base32Encode,
  base32Decode,
  otpauthUri,
  totpAt,
  verifyTotp,
};
