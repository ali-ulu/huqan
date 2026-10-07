'use strict';

/**
 * K1: the CognitiveMessage envelope and its reference frames (#3471).
 *
 * K0 (`lib/memory-knowledge-object.js`, #3470) fixed *what the kernel knows*.
 * K1 fixes *what one cognitive step carries*: the common envelope a message
 * moves between a source and a target -- goal, observation, prediction,
 * hypothesis, action, confidence, evidence references, a temporal context, a
 * budget and a trace id -- together with the reference frame that says where
 * the message is true.
 *
 * It is a schema and a comparison, nothing more. Building a message never
 * mutates the graph, admits a belief or executes an action; the payload is
 * proposer data, never authority.
 *
 * Two rules are taken literally from the plan
 * (`docs/reports/language-math-requirements-20261001.md`, K1 row):
 *
 * - "Frame uyumsuzluğu explicit unknown/review": comparing two frames yields
 *   `match`, `mismatch` or `unknown`, never a silent boolean. A mismatch asks
 *   for review; a field missing on either side is `unknown` rather than
 *   assumed equal.
 * - "Bağlamlar sessizce birleşmez": `compareReferenceFrames` reports
 *   `mergeAllowed` only when every frame field matched, so two different
 *   frames cannot be merged without an explicit decision.
 * - "Bir test failure'ın hangi frame'de doğru olduğu korunur": a message keeps
 *   its whole frame, so a failure is always reported against the frame it was
 *   observed in.
 *
 * A payload field with no input is an explicit `FIELD_UNKNOWN` warning with a
 * reason, never an empty placeholder that reads as "measured none". Unknown is
 * not invalid: `ok` stays true and the unknown fields are named.
 *
 * Reuse over duplication: the record shape, JSON-lossless content rule,
 * timestamp check and field-level error helpers come from
 * `lib/memory-schema-checks.js` -- the same base K0 uses -- instead of a second
 * validation vocabulary.
 */

const { isPlainObject } = require('./is-plain-object');
const {
  isLosslessJson,
  pushError,
  result,
  validateRequiredArray,
  validateRequiredString,
  validateTimestamp,
} = require('./memory-schema-checks');

const COGNITIVE_MESSAGE_TYPE = 'cognitive-message';
const REFERENCE_FRAME_TYPE = 'reference-frame';

/** The thirteen fields the CognitiveMessage envelope declares (K1). */
const COGNITIVE_MESSAGE_FIELDS = Object.freeze([
  'source',
  'target',
  'workspace',
  'goal',
  'observation',
  'prediction',
  'hypothesis',
  'action',
  'confidence',
  'evidenceRefs',
  'temporalContext',
  'budget',
  'traceId',
]);

// The fields a message may legitimately leave unmeasured. Absent or null is an
// explicit unknown, not an error and not an empty placeholder.
const COGNITIVE_PAYLOAD_FIELDS = Object.freeze([
  'goal',
  'observation',
  'prediction',
  'hypothesis',
  'action',
  'confidence',
  'temporalContext',
  'budget',
]);

/** The eight fields a reference frame carries (K1): where a message is true. */
const REFERENCE_FRAME_FIELDS = Object.freeze([
  'repo',
  'branch',
  'commit',
  'environment',
  'actor',
  'time',
  'goal',
  'task',
]);

const FRAME_COMPARISON_STATUS = Object.freeze({
  MATCH: 'match',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown',
});

const COGNITIVE_MESSAGE_ERROR_CODES = Object.freeze({
  INVALID_MESSAGE: 'INVALID_COGNITIVE_MESSAGE',
  INVALID_FRAME: 'INVALID_REFERENCE_FRAME',
  FIELD_UNKNOWN: 'FIELD_UNKNOWN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DUPLICATE_EVIDENCE_REF: 'DUPLICATE_EVIDENCE_REF',
});

const FRAME_COMPARISON_CODES = Object.freeze({
  MATCH: 'reference_frames_match',
  MISMATCH: 'reference_frame_mismatch',
  UNKNOWN: 'reference_frame_unknown',
  INVALID: 'invalid_reference_frame',
});

function present(value) {
  return value !== undefined && value !== null;
}

function unknownWarning(warnings, field) {
  warnings.push({
    code: COGNITIVE_MESSAGE_ERROR_CODES.FIELD_UNKNOWN,
    field,
    message: `${field} is unknown (no input); recorded as explicit unknown, not an empty placeholder`,
  });
}

function validateEvidenceRefs(errors, value) {
  if (!Array.isArray(value)) {
    pushError(errors, COGNITIVE_MESSAGE_ERROR_CODES.VALIDATION_ERROR, 'evidenceRefs', 'evidenceRefs must be an array (empty when there is no evidence)');
    return;
  }
  const seen = new Set();
  // Index by index: forEach skips holes, and JSON turns a hole into null, so a
  // sparse array must be refused rather than silently serialized as nulls.
  for (let index = 0; index < value.length; index += 1) {
    const ref = value[index];
    if (typeof ref !== 'string' || !ref.trim()) {
      pushError(errors, COGNITIVE_MESSAGE_ERROR_CODES.VALIDATION_ERROR, `evidenceRefs[${index}]`, `evidenceRefs[${index}] must be a non-empty reference`);
      continue;
    }
    if (seen.has(ref)) {
      pushError(errors, COGNITIVE_MESSAGE_ERROR_CODES.DUPLICATE_EVIDENCE_REF, `evidenceRefs[${index}]`, `evidenceRefs[${index}] duplicates an earlier reference`);
    }
    seen.add(ref);
  }
}

// A payload field is either a value that survives JSON unchanged or an explicit
// unknown. Anything else (a function, a bigint, a non-finite number, an
// accessor) is refused rather than silently dropped or nulled.
function validatePayloadField(errors, warnings, message, field) {
  if (!present(message[field])) {
    unknownWarning(warnings, field);
    return;
  }
  if (field === 'confidence') {
    const value = message.confidence;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      pushError(errors, COGNITIVE_MESSAGE_ERROR_CODES.VALIDATION_ERROR, 'confidence', 'confidence must be a number between 0 and 1');
    }
    return;
  }
  if (!isLosslessJson(message[field])) {
    pushError(errors, COGNITIVE_MESSAGE_ERROR_CODES.VALIDATION_ERROR, field, `${field} must survive JSON unchanged`);
  }
}

function validateCognitiveMessage(message) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(message)) {
    pushError(errors, COGNITIVE_MESSAGE_ERROR_CODES.INVALID_MESSAGE, '', 'cognitive message must be an object');
    return result(COGNITIVE_MESSAGE_TYPE, warnings, errors);
  }

  validateRequiredString(errors, message, 'source');
  validateRequiredString(errors, message, 'target');
  validateRequiredString(errors, message, 'workspace');
  validateRequiredString(errors, message, 'traceId');

  for (const field of COGNITIVE_PAYLOAD_FIELDS) validatePayloadField(errors, warnings, message, field);

  if (!present(message.evidenceRefs)) {
    pushError(errors, COGNITIVE_MESSAGE_ERROR_CODES.VALIDATION_ERROR, 'evidenceRefs', 'evidenceRefs is required (an empty array when there is no evidence)');
  } else {
    validateEvidenceRefs(errors, message.evidenceRefs);
  }

  return result(COGNITIVE_MESSAGE_TYPE, warnings, errors);
}

function validateReferenceFrame(frame) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(frame)) {
    pushError(errors, COGNITIVE_MESSAGE_ERROR_CODES.INVALID_FRAME, '', 'reference frame must be an object');
    return result(REFERENCE_FRAME_TYPE, warnings, errors);
  }
  for (const field of REFERENCE_FRAME_FIELDS) {
    if (field === 'time') continue;
    validateRequiredString(errors, frame, field);
  }
  if (validateRequiredString(errors, frame, 'time')) validateTimestamp(errors, frame.time, 'time');
  return result(REFERENCE_FRAME_TYPE, warnings, errors);
}

function comparison(status, code, reason, fields, mismatched, unresolved) {
  return Object.freeze({
    status,
    code,
    reason,
    fields: Object.freeze(fields),
    mismatched: Object.freeze(mismatched),
    unresolved: Object.freeze(unresolved),
    requiresReview: status !== FRAME_COMPARISON_STATUS.MATCH,
    mergeAllowed: status === FRAME_COMPARISON_STATUS.MATCH,
  });
}

// A frame field counts as carried only when it is a valid value: a non-blank
// string, and for `time` a parseable timestamp. Anything else -- absent, null,
// blank, a non-string, an unparseable time -- is unresolved, so a comparison
// never reads a missing or invalid field as "equal to the other side".
function carried(frame, field) {
  const value = frame[field];
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (field === 'time') return !Number.isNaN(Date.parse(value));
  return true;
}

/**
 * Compare two reference frames field by field. `expected` is the frame the
 * caller is comparing against; `observed` is the frame the message actually
 * carries. A field carried by both and equal is `match`; carried by both and
 * different is `mismatch`; carried by neither side is `unknown`. The overall
 * status is `mismatch` if anything differs, else `unknown` if anything is
 * unresolved, else `match`. Frames never merge unless every field matched, so
 * a partial or different frame always asks for review rather than merging
 * silently. Only a non-object input is undecidable (`invalid`).
 */
function compareReferenceFrames(expected, observed) {
  const fields = {};
  const mismatched = [];
  const unresolved = [];
  if (!isPlainObject(expected) || !isPlainObject(observed)) {
    for (const field of REFERENCE_FRAME_FIELDS) {
      fields[field] = FRAME_COMPARISON_STATUS.UNKNOWN;
      unresolved.push(field);
    }
    return comparison(FRAME_COMPARISON_STATUS.UNKNOWN, FRAME_COMPARISON_CODES.INVALID,
      'a reference frame is not an object, so the comparison cannot be decided', fields, mismatched, unresolved);
  }

  for (const field of REFERENCE_FRAME_FIELDS) {
    if (!carried(expected, field) || !carried(observed, field)) {
      fields[field] = FRAME_COMPARISON_STATUS.UNKNOWN;
      unresolved.push(field);
    } else if (expected[field] === observed[field]) {
      fields[field] = FRAME_COMPARISON_STATUS.MATCH;
    } else {
      fields[field] = FRAME_COMPARISON_STATUS.MISMATCH;
      mismatched.push(field);
    }
  }

  if (mismatched.length) {
    return comparison(FRAME_COMPARISON_STATUS.MISMATCH, FRAME_COMPARISON_CODES.MISMATCH,
      `reference frame fields differ: ${mismatched.join(', ')}`, fields, mismatched, unresolved);
  }
  if (unresolved.length) {
    return comparison(FRAME_COMPARISON_STATUS.UNKNOWN, FRAME_COMPARISON_CODES.UNKNOWN,
      `reference frame fields are unresolved: ${unresolved.join(', ')}`, fields, mismatched, unresolved);
  }
  return comparison(FRAME_COMPARISON_STATUS.MATCH, FRAME_COMPARISON_CODES.MATCH,
    'reference frames are identical on every field', fields, mismatched, unresolved);
}

module.exports = Object.freeze({
  COGNITIVE_MESSAGE_ERROR_CODES,
  COGNITIVE_MESSAGE_FIELDS,
  COGNITIVE_MESSAGE_TYPE,
  COGNITIVE_PAYLOAD_FIELDS,
  FRAME_COMPARISON_CODES,
  FRAME_COMPARISON_STATUS,
  REFERENCE_FRAME_FIELDS,
  REFERENCE_FRAME_TYPE,
  compareReferenceFrames,
  validateCognitiveMessage,
  validateReferenceFrame,
});
