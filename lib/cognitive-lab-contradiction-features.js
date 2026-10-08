'use strict';

/**
 * R50 PR3 — frozen deterministic feature extractor (issue #3582, roadmap R50).
 *
 * The fusion arm (C) is only allowed to combine the deterministic detector
 * outputs and a bounded set of claim metadata; it is not allowed to discover a
 * new semantic relation. This module is that bounded feature set, frozen by the
 * preregistration (§6) and pinned by name and order so a reordering is a visible
 * contract change rather than a silent one.
 *
 * Forbidden by the preregistration and deliberately absent here: raw text
 * tokens, TF-IDF or embeddings, opposition-pair identity, `candidateId` or a
 * source path, the human label, the split id or the reviewer id, and any
 * external model/Jev/NLI score. `maxDeclaredConfidence` is an input feature
 * only; it is never read as a probability.
 *
 * The extractor is a pure function of one corpus record: no store, no clock, no
 * randomness. `featureSpecDigest` pins the name/order list so an artifact can
 * record exactly which feature contract produced it.
 */

const { stableStringify, sha256Hex } = require('./hash-chain');
const { runContradictionRules } = require('./contradiction-rules');
const { sameSubject } = require('./contradiction-rules-text');
const { isPlainObject } = require('./is-plain-object');

const FEATURE_SPEC_VERSION = 'huqan-contradiction-features-v1';

// The rule ids in the repo's own `runContradictionRules` order, then the bounded
// metadata block. The order is the vector layout; changing it changes every
// trained readout, so it is frozen here and recorded in the artifact.
const FIRED_RULES = Object.freeze([
  'NUMERICAL_CONFLICT',
  'VALUE_CONFLICT',
  'TYPE_CONFLICT',
  'NEGATION_CONFLICT',
  'UNIT_CONFLICT',
  'CAUSE_PREVENT_OPPOSITION',
  'SEMANTIC_OPPOSITION',
  'RELATION_INVERSION',
  'PREDICATE_DRIFT',
]);

const FEATURE_ORDER = Object.freeze([
  ...FIRED_RULES.map((rule) => `fired.${rule}`),
  'contradictionSignalCount',
  'maxSeverity',
  'maxDeclaredConfidence',
  'evidenceCount',
  'sameSubject',
  'sourceTypeKnown',
  'sameSourceType',
  'frameKnown',
  'sameFrame',
]);

const FEATURE_SPEC_DIGEST = sha256Hex(stableStringify({ version: FEATURE_SPEC_VERSION, order: FEATURE_ORDER }));

const FEATURES_ERROR_CODES = Object.freeze({
  INVALID_RECORD: 'features_invalid_record',
});

class ContradictionFeaturesError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'ContradictionFeaturesError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new ContradictionFeaturesError(code, path, message);
}

function claimField(claim, field) {
  if (!isPlainObject(claim)) return '';
  const value = claim[field];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Extract the frozen feature vector from one corpus record.
 *
 * @param {object} record `{ stored, incoming }` claims; split/label/pairId are
 *   never read, so a label edit cannot move a feature.
 * @returns {Readonly<{ vector:ReadonlyArray<number>, named:Readonly<object> }>}
 *   `vector` is the numeric vector in `FEATURE_ORDER`; booleans are 0/1.
 */
function extractFeatures(record) {
  if (!isPlainObject(record)) fail(FEATURES_ERROR_CODES.INVALID_RECORD, 'record', 'record must be an object');
  const stored = record.stored;
  const incoming = record.incoming;
  const signals = runContradictionRules(stored, incoming);
  const fired = new Set();
  let maxSeverity = 0;
  let maxDeclaredConfidence = 0;
  let evidenceCount = 0;
  for (const signal of signals) {
    if (typeof signal.rule === 'string') fired.add(signal.rule);
    const severity = Number(signal.severity);
    if (Number.isFinite(severity)) maxSeverity = Math.max(maxSeverity, severity);
    const confidence = Number(signal.confidence);
    if (Number.isFinite(confidence)) maxDeclaredConfidence = Math.max(maxDeclaredConfidence, confidence);
    evidenceCount += Array.isArray(signal.evidence) ? signal.evidence.length : 0;
  }

  const storedSourceType = claimField(stored, 'sourceType');
  const incomingSourceType = claimField(incoming, 'sourceType');
  const storedFrame = claimField(stored, 'frameId');
  const incomingFrame = claimField(incoming, 'frameId');
  const sourceTypeKnown = storedSourceType !== '' && incomingSourceType !== '';
  const frameKnown = storedFrame !== '' && incomingFrame !== '';

  const named = Object.freeze({
    contradictionSignalCount: signals.length,
    maxSeverity,
    maxDeclaredConfidence,
    evidenceCount,
    sameSubject: sameSubject(stored, incoming) ? 1 : 0,
    sourceTypeKnown: sourceTypeKnown ? 1 : 0,
    sameSourceType: sourceTypeKnown && storedSourceType === incomingSourceType ? 1 : 0,
    frameKnown: frameKnown ? 1 : 0,
    sameFrame: frameKnown && storedFrame === incomingFrame ? 1 : 0,
  });
  const vector = Object.freeze(FEATURE_ORDER.map((name) => {
    if (name.startsWith('fired.')) return fired.has(name.slice('fired.'.length)) ? 1 : 0;
    return named[name];
  }));
  return Object.freeze({ vector, named });
}

module.exports = {
  FEATURE_SPEC_VERSION,
  FEATURE_SPEC_DIGEST,
  FEATURE_ORDER,
  FIRED_RULES,
  FEATURES_ERROR_CODES,
  ContradictionFeaturesError,
  extractFeatures,
};
