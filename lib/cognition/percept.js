'use strict';

/**
 * COG-M1 (#4064): folds the different observation modalities into one `Percept`
 * built on the shared K1 `CognitiveMessage` and reference frame. Pure Core: no
 * I/O, no clock, no randomness. Perception is an observation, never an
 * authority; `reported` is never upgraded to `observed`.
 */

const { COGNITION_STATUS, AUTHORITY, freezeResult } = require('./contract');
const {
  COGNITIVE_MESSAGE_ERROR_CODES,
  validateCognitiveMessage,
  validateReferenceFrame,
} = require('../memory-cognitive-message');
const { contentHash } = require('../content-hash');
const { stableStringify } = require('../hash-chain');
const { isPlainObject } = require('../is-plain-object');

const SCHEMA_VERSION = 'huqan-cognition-percept-v1';
const PERCEPT_ID_HEX = 24;
const MAX_OBSERVATION_BYTES = 4096;

const MODALITIES = Object.freeze([
  'file-effect',
  'browser-event',
  'ingest',
  'step-report',
  'prediction-error',
  'outcome',
]);

const PROVENANCE = Object.freeze(['observed', 'reported', 'derived']);

const FRAME_STATUS = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  ABSENT: 'absent',
});

// A step report is what the agent says it did, so it can never be `observed`.
const PROVENANCE_BY_MODALITY = Object.freeze({
  'step-report': Object.freeze(['reported']),
});

/** Fields excluded from the habituation key: they change every time, content does not. */
const KEY_EXCLUDED_MESSAGE_FIELDS = Object.freeze(['traceId', 'temporalContext']);
const KEY_EXCLUDED_FRAME_FIELDS = Object.freeze(['time']);

const isText = (value) => typeof value === 'string' && value.trim() !== '';

function without(value, fields) {
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) copy[key] = value[key];
  }
  return copy;
}

/**
 * The content the habituation key is taken over: the same percept minus the
 * trace id and every timestamp, so repeated exposure keeps one key.
 */
function keyBasis({ modality = null, message = null, frame = null }) {
  return {
    modality: typeof modality === 'string' ? modality : null,
    message: without(message, KEY_EXCLUDED_MESSAGE_FIELDS),
    frame: without(frame, KEY_EXCLUDED_FRAME_FIELDS),
  };
}

function hashOf(value, prefix) {
  return prefix + contentHash(stableStringify(value)).slice(0, PERCEPT_ID_HEX);
}

/**
 * Stable habituation key for a percept (or for the parts a percept is built
 * from). Ignores `traceId`, `temporalContext` and `frame.time`.
 *
 * @param {{modality?: string, message?: object, frame?: object}} input
 * @returns {string}
 */
function perceptKeyOf(input) {
  const source = isPlainObject(input) ? input : {};
  return hashOf(keyBasis(source), 'pk_');
}

const reject = (fields, reason) =>
  freezeResult({
    schemaVersion: SCHEMA_VERSION,
    status: COGNITION_STATUS.REJECT,
    reason,
    modality: fields.modality,
    provenance: fields.provenance,
    authority: AUTHORITY.OBSERVATION_ONLY,
  });

function frameOf(frame) {
  if (frame === undefined || frame === null) {
    return { frame: null, frameStatus: FRAME_STATUS.ABSENT };
  }
  const verdict = validateReferenceFrame(frame);
  return {
    frame,
    frameStatus: verdict.ok ? FRAME_STATUS.COMPLETE : FRAME_STATUS.PARTIAL,
  };
}

function warningsOf(validation) {
  return validation.warnings
    .filter((warning) => warning.code === COGNITIVE_MESSAGE_ERROR_CODES.FIELD_UNKNOWN)
    .map((warning) => ({ code: warning.code, field: warning.field }));
}

/**
 * @param {object} input `{ modality, provenance, message, frame }`
 * @returns {Readonly<object>} a percept, or a REJECT result; never throws
 */
function buildPercept(input) {
  const shape = isPlainObject(input) ? input : {};
  const { modality = null, provenance = null, message = null, frame = null } = shape;
  const echo = { modality: typeof modality === 'string' ? modality : null, provenance: typeof provenance === 'string' ? provenance : null };

  if (!isPlainObject(input)) return reject(echo, 'invalid_input');
  if (!MODALITIES.includes(modality)) return reject(echo, 'unknown_modality');
  if (!PROVENANCE.includes(provenance)) return reject(echo, 'unknown_provenance');
  const allowed = PROVENANCE_BY_MODALITY[modality];
  if (allowed && !allowed.includes(provenance)) return reject(echo, `provenance_not_allowed:${modality}`);

  // A throwing accessor on the message escapes validateCognitiveMessage's own
  // field reads, and stableStringify can throw on the same input; both must
  // fail closed instead of escaping a signal producer that never throws.
  let validation;
  try {
    validation = validateCognitiveMessage(message);
  } catch (_) {
    return reject(echo, 'unhashable_input');
  }
  if (!validation.ok) return reject(echo, 'invalid_cognitive_message');
  let observationTooLarge;
  try {
    observationTooLarge = Buffer.byteLength(stableStringify(message), 'utf8') > MAX_OBSERVATION_BYTES;
  } catch (_) {
    return reject(echo, 'unhashable_input');
  }
  if (observationTooLarge) {
    return reject(echo, 'percept_too_large');
  }

  const { frame: keptFrame, frameStatus } = frameOf(frame);
  const identity = { modality, message, frame: keptFrame };

  let perceptId;
  let perceptKey;
  try {
    perceptId = hashOf(identity, 'pc_');
    perceptKey = perceptKeyOf(identity);
  } catch (_) {
    // Hashing must never throw out of a signal producer; unhashable input fails closed.
    return reject(echo, 'unhashable_input');
  }

  return freezeResult({
    schemaVersion: SCHEMA_VERSION,
    status: COGNITION_STATUS.MEASURED,
    perceptId,
    perceptKey,
    modality,
    provenance,
    message,
    frame: keptFrame,
    frameStatus,
    validation: { ok: true, warnings: warningsOf(validation) },
    authority: AUTHORITY.OBSERVATION_ONLY,
  });
}

module.exports = {
  SCHEMA_VERSION,
  PERCEPT_ID_HEX,
  MAX_OBSERVATION_BYTES,
  MODALITIES,
  PROVENANCE,
  FRAME_STATUS,
  buildPercept,
  perceptKeyOf,
};
