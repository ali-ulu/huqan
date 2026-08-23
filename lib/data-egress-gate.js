'use strict';

/**
 * AB9 — Data Egress Gate.
 *
 * `tool-call-gate` (AB2) already classifies post/webhook/send-style actions
 * as external side effects requiring review (EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED,
 * NETWORK_MUTATION_HINTS / SIDE_EFFECT_ACTIONS), and AB2's own secret
 * detection already scans the outgoing payload for secret-looking values.
 * This module adds the piece that's still missing: scanning an outbound
 * payload for PII (personal data), on top of reusing — not reimplementing —
 * AB7's secret detector for the secret half of the same scan.
 *
 * Detected PII types (deliberately algorithmic/checksum-backed where a
 * checksum exists, to keep false positives low):
 *   - email address
 *   - Turkish national ID (TCKN) — 11-digit, checksum-validated
 *   - US Social Security Number (SSN) — dashed format
 *   - credit card number — Luhn-checksum-validated
 *   - phone number — requires a leading '+' or common separators, since a
 *     bare run of digits is indistinguishable from any other numeric ID
 *
 * Deliberately NOT attempted: free-text street/postal address detection.
 * There is no reliable algorithm for it (unlike TCKN/SSN/credit-card, which
 * have checksums, or email, which has a fixed shape), and a naive keyword
 * heuristic would mostly produce false positives/negatives. Flagged as an
 * explicit non-goal rather than shipped as an unreliable heuristic.
 */

const { hasSecretLookingValue, redactSecretValues } = require('./tool-call-gate');

const AB9_GATE_VERSION = 'AB9-v0.1.0';

const PII_TYPES = Object.freeze({
  EMAIL: 'email',
  TCKN: 'tckn',
  SSN: 'ssn',
  CREDIT_CARD: 'credit_card',
  PHONE: 'phone',
  IBAN: 'iban',
});

const EMAIL_PATTERN = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
// Requires a leading '+' or interior separators so a plain numeric ID
// (order number, timestamp, etc.) is not mistaken for a phone number.
const PHONE_PATTERN = /(?:\+\d{1,3}[\s-]?)(?:\(?\d{2,4}\)?[\s-]?){2,5}\d{2,4}|\b\d{3}[\s-]\d{3}[\s-]\d{4}\b/g;
const DIGIT_RUN_PATTERN = /\d[\d\s-]{9,25}\d/g;
// ISO 13616 shape: 2-letter country + 2 check digits + up to 30 alphanumerics.
// Checksum-validated below (mod-97) to keep unrelated uppercase+digit runs
// (order codes, build IDs) from being mistaken for an account number.
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

function onlyDigits(text) {
  return String(text || '').replace(/\D/g, '');
}

/**
 * Turkish national ID (TCKN) checksum: 11 digits, first digit non-zero,
 * digit[10] = ((sum of digits at odd positions 1,3,5,7,9) * 7 -
 * (sum of digits at even positions 2,4,6,8)) mod 10, and
 * digit[11] = (sum of first 10 digits) mod 10.
 */
function isValidTckn(digits) {
  if (!/^\d{11}$/.test(digits) || digits[0] === '0') return false;
  const d = digits.split('').map(Number);
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  const check10 = ((oddSum * 7) - evenSum) % 10;
  if (((check10 + 10) % 10) !== d[9]) return false;
  const first10Sum = d.slice(0, 10).reduce((a, b) => a + b, 0);
  return (first10Sum % 10) === d[10];
}

/**
 * IBAN mod-97 checksum (ISO 7064): move the leading 4 characters (country
 * code + check digits) to the end, convert letters to numbers (A=10..Z=35),
 * and the resulting numeric string must be congruent to 1 mod 97. Computed
 * digit-by-digit to avoid precision loss on the long numeric expansion.
 */
function isValidIban(candidate) {
  const value = String(candidate || '').toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;
  const rearranged = value.slice(4) + value.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Standard Luhn checksum, used to validate candidate credit card numbers. */
function isValidLuhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Scans free text for PII matches. Returns [] when nothing is found. */
function findPiiInText(text) {
  const str = String(text || '');
  const findings = [];

  for (const match of str.match(EMAIL_PATTERN) || []) {
    findings.push({ type: PII_TYPES.EMAIL, match });
  }

  for (const match of str.match(SSN_PATTERN) || []) {
    findings.push({ type: PII_TYPES.SSN, match });
  }

  for (const match of str.match(PHONE_PATTERN) || []) {
    findings.push({ type: PII_TYPES.PHONE, match });
  }

  for (const match of str.match(IBAN_PATTERN) || []) {
    if (isValidIban(match)) findings.push({ type: PII_TYPES.IBAN, match });
  }

  for (const match of str.match(DIGIT_RUN_PATTERN) || []) {
    const digits = onlyDigits(match);
    if (digits.length === 11 && isValidTckn(digits)) {
      findings.push({ type: PII_TYPES.TCKN, match });
    } else if (digits.length >= 13 && digits.length <= 19 && isValidLuhn(digits)) {
      findings.push({ type: PII_TYPES.CREDIT_CARD, match });
    }
  }

  return findings;
}

const { isPlainObject } = require('./is-plain-object');

/** Recursively collects PII findings from any string leaf in `value`. */
function collectPiiFindings(value, findings = []) {
  if (typeof value === 'string') {
    findings.push(...findPiiInText(value));
    return findings;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPiiFindings(item, findings);
    return findings;
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) collectPiiFindings(nested, findings);
    return findings;
  }
  return findings;
}

/** Recursively replaces PII matches (and, via AB7, secret matches) with a placeholder. */
function redactPiiInText(text) {
  let out = String(text || '');
  out = out.replace(EMAIL_PATTERN, '[REDACTED_PII:email]');
  out = out.replace(SSN_PATTERN, '[REDACTED_PII:ssn]');
  out = out.replace(PHONE_PATTERN, '[REDACTED_PII:phone]');
  out = out.replace(IBAN_PATTERN, (match) => (isValidIban(match) ? '[REDACTED_PII:iban]' : match));
  out = out.replace(DIGIT_RUN_PATTERN, (match) => {
    const digits = onlyDigits(match);
    if (digits.length === 11 && isValidTckn(digits)) return '[REDACTED_PII:tckn]';
    if (digits.length >= 13 && digits.length <= 19 && isValidLuhn(digits)) return '[REDACTED_PII:credit_card]';
    return match;
  });
  return out;
}

function redactPiiValues(value) {
  if (typeof value === 'string') return redactPiiInText(value);
  if (Array.isArray(value)) return value.map(redactPiiValues);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, nested] of Object.entries(value)) out[key] = redactPiiValues(nested);
    return out;
  }
  return value;
}

/**
 * Evaluates an outbound payload for PII and secrets, and returns a scrubbed
 * copy. Secret detection/redaction is delegated entirely to AB7
 * (hasSecretLookingValue / redactSecretValues) — AB9 does not reimplement
 * secret matching, only adds the PII half.
 */
function evaluateEgress(payload) {
  const piiFindings = collectPiiFindings(payload);
  const secretDetected = hasSecretLookingValue(payload);

  let scrubbed = payload;
  if (piiFindings.length > 0) scrubbed = redactPiiValues(scrubbed);
  if (secretDetected) scrubbed = redactSecretValues(scrubbed);

  return {
    scrubbed,
    piiDetected: piiFindings.length > 0,
    piiTypes: [...new Set(piiFindings.map((f) => f.type))],
    secretDetected,
    gateVersion: AB9_GATE_VERSION,
  };
}

module.exports = {
  AB9_GATE_VERSION,
  PII_TYPES,
  isValidTckn,
  isValidLuhn,
  isValidIban,
  findPiiInText,
  evaluateEgress,
};
