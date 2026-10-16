'use strict';

/**
 * Verify-status vocabulary — canonical English at the API boundary,
 * legacy Turkish accepted.
 *
 * This module follows the compatibility pattern already established by
 * RFC-001 (docs/rfcs/RFC-001-huqan-canonical-naming-and-legacy-compatibility.md)
 * and the AXIOM_* -> HUQAN_* environment migration
 * (docs/environment-variable-migration.md):
 *
 *   a reader accepts both spellings; a writer emits only the canonical form.
 *
 * Scope is deliberately narrow. The *internal* verify status vocabulary
 * ('dogrulandi' / 'celiski' / 'bilinmiyor') produced by lib/verify.js,
 * lib/reasoning-trace.js and lib/semantic-score.js is NOT renamed here. This
 * module is an edge adapter only: it translates on the way out of the HTTP
 * API and accepts either spelling on the way in.
 *
 * Nothing hashed, signed or persisted carries these values — see
 * docs/verify-status-vocabulary-migration.md for the measured blast radius.
 */

// Canonical, English, API-boundary values.
const CANONICAL_VERIFY_STATUSES = Object.freeze([
  'verified',
  'contradicted',
  'unknown',
]);

// Legacy, Turkish, internal/runtime values. Still accepted by every reader.
const LEGACY_VERIFY_STATUSES = Object.freeze([
  'dogrulandi',
  'celiski',
  'bilinmiyor',
]);

const LEGACY_TO_CANONICAL = Object.freeze({
  dogrulandi: 'verified',
  celiski: 'contradicted',
  bilinmiyor: 'unknown',
});

const CANONICAL_TO_LEGACY = Object.freeze({
  verified: 'dogrulandi',
  contradicted: 'celiski',
  unknown: 'bilinmiyor',
});

const CANONICAL_SET = new Set(CANONICAL_VERIFY_STATUSES);
const LEGACY_SET = new Set(LEGACY_VERIFY_STATUSES);

/**
 * Canonical (English) form of a verify status, for emission at the API
 * boundary. Accepts both the canonical and the legacy spelling.
 *
 * Fail-safe rather than fail-closed: an unrecognized value degrades to
 * 'unknown'. That is the correct direction of failure for a verifier — an
 * unmapped status must never be presented as 'verified'.
 */
function toCanonicalVerifyStatus(value) {
  if (typeof value !== 'string') return 'unknown';
  if (CANONICAL_SET.has(value)) return value;
  // #1320: a plain `table[value]` lookup returns an inherited
  // Object.prototype member (a function) for a value like 'constructor' or
  // 'toString' -- truthy, so `|| 'unknown'` never ran. That result then
  // reached toPublicVerifyPayload's `status` field, where JSON.stringify
  // silently drops a function value, so the field vanished from the
  // response entirely instead of degrading to 'unknown'. Object.hasOwn
  // restricts the lookup to the table's own mapped keys.
  return Object.hasOwn(LEGACY_TO_CANONICAL, value) ? LEGACY_TO_CANONICAL[value] : 'unknown';
}

/**
 * Legacy (internal) form of a verify status, for handing a value back to
 * runtime code that still compares against the Turkish vocabulary. Accepts
 * both spellings. Degrades to 'bilinmiyor' for the same reason as above.
 */
function toLegacyVerifyStatus(value) {
  if (typeof value !== 'string') return 'bilinmiyor';
  if (LEGACY_SET.has(value)) return value;
  // #1320: see toCanonicalVerifyStatus's matching guard above.
  return Object.hasOwn(CANONICAL_TO_LEGACY, value) ? CANONICAL_TO_LEGACY[value] : 'bilinmiyor';
}

/** True when the value is a recognized status in either vocabulary. */
function isKnownVerifyStatus(value) {
  return typeof value === 'string' && (CANONICAL_SET.has(value) || LEGACY_SET.has(value));
}

/**
 * Project an internal verify payload ({ status, confidence, evidence, ... })
 * into its canonical English API-boundary form. Every other field is passed
 * through untouched; only `status` is translated.
 */
function toPublicVerifyPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    status: toCanonicalVerifyStatus(payload.status),
  };
}

// The only keys in the verify envelope that carry a verify status. Measured
// against a live `kernel.verify()` result, not guessed — see
// docs/verify-status-vocabulary-migration.md for the enumeration.
const VERIFY_STATUS_KEYS = Object.freeze(['status', 'finalStatus']);
const VERIFY_STATUS_KEY_SET = new Set(VERIFY_STATUS_KEYS);

/**
 * Deep-project a full verify envelope into a target vocabulary, sharing one
 * implementation between the canonical and legacy directions (they were
 * previously two copy-pasted functions that could drift independently --
 * see #1320).
 *
 * Two guards keep this from corrupting unrelated data:
 *
 *  1. key guard   — only `status` / `finalStatus` keys are considered;
 *  2. value guard — a value is rewritten only when it is already a recognized
 *                   verify status in either vocabulary. Any other `status`
 *                   in the envelope (an approval 'pending', a phase 'done')
 *                   passes through byte-identical.
 *
 * Structure, key order and every other value are preserved -- including an
 * own-enumerable '__proto__' key. #1300 and #1320: a plain assignment here
 * (projected[childKey] = ...) treats an own-enumerable '__proto__' key in
 * `value` -- e.g. from JSON.parse('{"__proto__":{...}}') -- as setting the
 * freshly created object's actual [[Prototype]] rather than a data property,
 * both polluting `projected` and silently dropping that field from the
 * output. Object.defineProperty bypasses the inherited '__proto__' accessor
 * and always writes an ordinary own data property, so the value survives
 * projection exactly like any other key.
 */
function makeEnvelopeProjector(mapStatus) {
  function project(value, key) {
    if (typeof value === 'string') {
      if (VERIFY_STATUS_KEY_SET.has(key) && isKnownVerifyStatus(value)) {
        return mapStatus(value);
      }
      return value;
    }
    if (Array.isArray(value)) {
      // Array elements inherit the key of the array that holds them, so
      // `steps: [...]` does not accidentally make every element a status.
      return value.map(item => project(item, null));
    }
    if (value && typeof value === 'object') {
      const projected = {};
      for (const childKey of Object.keys(value)) {
        Object.defineProperty(projected, childKey, {
          value: project(value[childKey], childKey),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return projected;
    }
    return value;
  }
  return project;
}

const projectEnvelope = makeEnvelopeProjector(toCanonicalVerifyStatus);

/** Deep-project a full verify envelope into its canonical English boundary form. */
function toPublicVerifyEnvelope(value) {
  return projectEnvelope(value, null);
}

/**
 * The legacy-vocabulary mirror of toPublicVerifyEnvelope, for exactly one
 * caller: the MCP `verify` tool, whose declared output schema
 * (mcpServer.js VERIFY_STATUS) is a wire contract with external clients and
 * still names the legacy values. Now that the kernel emits canonical English
 * internally, MCP has to project back on the way out or its responses would
 * stop matching the schema it advertises.
 *
 * This is the documented remaining gap from
 * docs/verify-status-vocabulary-migration.md, not a new one: flipping that
 * enum needs its own compatibility gate with recorded evidence, following
 * RFC-001's M1-M4 pattern.
 */
const projectEnvelopeLegacy = makeEnvelopeProjector(toLegacyVerifyStatus);

function toLegacyVerifyEnvelope(value) {
  return projectEnvelopeLegacy(value, null);
}

module.exports = {
  VERIFY_STATUS_KEYS,
  CANONICAL_VERIFY_STATUSES,
  LEGACY_VERIFY_STATUSES,
  LEGACY_TO_CANONICAL,
  CANONICAL_TO_LEGACY,
  toCanonicalVerifyStatus,
  toLegacyVerifyStatus,
  isKnownVerifyStatus,
  toPublicVerifyPayload,
  toPublicVerifyEnvelope,
  toLegacyVerifyEnvelope,
};
