'use strict';

/**
 * Secret scan of the hash-bound content in an evidence pack (#4253, CWE-693).
 *
 * A signature is public by construction, and a random base64 signature trips the
 * secret heuristic about one time in five; the secret check reads what a
 * signature covers, not the signature itself.
 *
 * #4253 (CWE-693): the exemption used to be *name-based* -- any field named
 * `signature` (or `bundleSignature`) was dropped before the scan, so a secret
 * placed in a `signature` field was neither refused nor scrubbed and left the
 * pack raw. The exemption is now *format-based*: a field is exempt only when its
 * value is a well-formed ed25519 signature (64 bytes) -- the shape the pack's
 * own issuer signature has. A `signature` field holding anything else (a
 * credential, a token, a blob) is scanned like any other value.
 *
 * The scan is *recorded*, not asserted: the producer self check must be able to
 * show what the scan actually ran over and whether it exempted a signature,
 * rather than restating the string `no secret-looking value`.
 */

const { hasSecretLookingValue } = require('../tool-call-gate-secrets');

const ED25519_SIGNATURE_BYTES = 64;
const SIGNATURE_FIELD_NAMES = new Set(['signature', 'bundleSignature']);

/** Check if value is a valid 64-byte ed25519 signature (base64 or base64url). */
function looksLikeEd25519Signature(value) {
  if (typeof value !== 'string') return false;
  // Try base64url first (what the pack's own signature uses)
  try {
    if (Buffer.from(value, 'base64url').length === ED25519_SIGNATURE_BYTES) return true;
  } catch {}
  // Try standard base64 (what signPackManifest produces with toString('base64'))
  try {
    if (Buffer.from(value, 'base64').length === ED25519_SIGNATURE_BYTES) return true;
  } catch {}
  return false;
}

/**
 * Deep copy of `value` with signature-shaped fields left in place but excluded
 * from the secret scan. A `signature` field whose value is not a well-formed
 * ed25519 signature is *kept* and therefore scanned like any other value.
 *
 * @returns {{value: object, exempt: boolean}} `exempt` is true when at least one
 * signature-shaped field was dropped, so callers can report that the scan
 * actually skipped a signature rather than the whole value.
 */
function withoutSignatures(value) {
  if (Array.isArray(value)) {
    const mapped = value.map((item) => withoutSignatures(item));
    return { value: mapped.map((entry) => entry.value), exempt: mapped.some((entry) => entry.exempt) };
  }
  if (!value || typeof value !== 'object') return { value, exempt: false };
  const out = {};
  let exempt = false;
  for (const [key, inner] of Object.entries(value)) {
    if (SIGNATURE_FIELD_NAMES.has(key) && looksLikeEd25519Signature(inner)) { exempt = true; continue; }
    const nested = withoutSignatures(inner);
    if (nested.exempt) exempt = true;
    out[key] = nested.value;
  }
  return { value: out, exempt };
}

/**
 * Scan every hash-bound value and report the result. A secret-looking value
 * still refuses the pack, but the scan is also *recorded*: the producer self
 * check must be able to show that the scan actually ran over the bytes that
 * were packed, not assert the string `no secret-looking value` (#4253).
 *
 * @returns {{files: string[], signatureExempt: number, secretFound: boolean}}
 */
function scanHashBound(hashBound) {
  const files = [];
  let signatureExempt = 0;
  let secretFound = false;
  for (const [file, value] of hashBound) {
    const { value: stripped, exempt } = withoutSignatures(value);
    if (exempt) signatureExempt += 1;
    files.push(file);
    if (hasSecretLookingValue(stripped)) secretFound = true;
  }
  return { files, signatureExempt, secretFound };
}

module.exports = { scanHashBound, withoutSignatures, looksLikeEd25519Signature };
