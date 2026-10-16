'use strict';

// Pure record helpers for provenance, moved verbatim from
// lib/provenance-ingest.js (#2246): text shaping, confidence clamping and
// provenance-id minting. No project requires: the builder
// (lib/provenance-ingest.js) depends downward on this leaf.

const VALID_SOURCE_TYPES = new Set([
  'document',
  'api',
  'user',
  'agent',
  'system',
  'github',
  'import',
  'llm',
  // Internal-only. Written by paths inside this repository rather than by an
  // external source. They were emitted long before they were declared here,
  // which meant every one of them scored the unknown fallback; see
  // test/ingest-source-type-trust-weights.test.js.
  //
  // These three are absent from SOURCE_TYPES in atp-conformance.js on purpose:
  // that set gates packages arriving from external clients, which may not claim
  // to be the kernel writing about itself. Do not add them there (#2040).
  'manual', // a human typing a fact directly, with no external reference
  'decision', // a recorded decision, structured but internal
  'background_inference', // the kernel writing about its own bookkeeping
]);

/**
 * Identity and trust ceiling for a source type that failed classification
 * (#742).
 *
 * An unrecognized sourceType used to be rewritten to 'system', which the
 * default policy scores 0.5 — the same floor at which
 * admissionRiskFromConfidence() stops treating a write as review-worthy. So a
 * caller could take a low-trust known type such as 'llm' (0.4), misspell it as
 * 'llm-custom', and have it promoted past the source-based review gate. The
 * warning never affected the decision.
 *
 * An invalid type must never be more trusted than the type it failed to
 * classify as, so the ceiling sits strictly below every registered default
 * (the strictest is background_inference at 0.3). The ceiling is enforced in
 * code rather than by a policy entry, so a policy file that omits it cannot
 * reopen the gap.
 */
const INVALID_SOURCE_TYPE = 'invalid';
const INVALID_SOURCE_TYPE_MAX_CONFIDENCE = 0.2;

function nowIso() {
  return new Date().toISOString();
}

function sanitize(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function clampConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(1, value));
}

module.exports = {
  INVALID_SOURCE_TYPE,
  INVALID_SOURCE_TYPE_MAX_CONFIDENCE,
  VALID_SOURCE_TYPES,
  clampConfidence,
  nowIso,
  sanitize,
};
