'use strict';

/**
 * Characterisation tests for the CognitiveMessage envelope and reference
 * frames (#3471, K1).
 *
 * Pinned here: the thirteen envelope fields and the eight frame fields; that a
 * missing payload field is an explicit unknown rather than a silent empty
 * placeholder; that JSON-lossless content is enforced through the same base K0
 * uses; and the plan's literal rule that a frame mismatch is an explicit
 * `unknown`/review, never a silent merge.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../lib/memory-cognitive-message');

const NOW = '2026-10-06T12:00:00.000Z';

function frame(overrides = {}) {
  return {
    repo: 'ali-ulu/huqan',
    branch: 'main',
    commit: '128197e6db5230225e057c6f8327f9eb0e08b585',
    environment: 'local',
    actor: 'operator',
    time: NOW,
    goal: 'ship K1',
    task: 'cognitive-message',
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    source: 'agent-a',
    target: 'agent-b',
    workspace: 'ws-1',
    goal: { text: 'ship K1' },
    observation: { text: 'tests pass' },
    prediction: { text: 'green' },
    hypothesis: { text: 'the fix holds' },
    action: { text: 'merge' },
    confidence: 0.7,
    evidenceRefs: ['ref-1', 'ref-2'],
    temporalContext: { observedAt: NOW },
    budget: { tokens: 100, calls: 1 },
    traceId: 'tr-1',
    ...overrides,
  };
}

function codes(outcome) {
  return outcome.errors.map((e) => `${e.code}:${e.field}`);
}

function warningFields(outcome) {
  return outcome.warnings.filter((w) => w.code === COGNITIVE_MESSAGE_ERROR_CODES.FIELD_UNKNOWN).map((w) => w.field).sort();
}

test('the envelope declares the thirteen K1 fields', () => {
  assert.deepEqual([...COGNITIVE_MESSAGE_FIELDS], ['source', 'target', 'workspace', 'goal', 'observation', 'prediction',
    'hypothesis', 'action', 'confidence', 'evidenceRefs', 'temporalContext', 'budget', 'traceId']);
  // Every payload field is one of the declared fields; the four routing fields
  // (source/target/workspace/traceId) and evidenceRefs are always required.
  assert.ok(COGNITIVE_PAYLOAD_FIELDS.every((f) => COGNITIVE_MESSAGE_FIELDS.includes(f)));
});

test('the frame declares the eight K1 fields', () => {
  assert.deepEqual([...REFERENCE_FRAME_FIELDS], ['repo', 'branch', 'commit', 'environment', 'actor', 'time', 'goal', 'task']);
});

test('a full message validates with no unknown payload fields', () => {
  const outcome = validateCognitiveMessage(message());
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  assert.equal(outcome.type, COGNITIVE_MESSAGE_TYPE);
  assert.deepEqual(warningFields(outcome), []);
});

test('the four routing fields and evidenceRefs are required', () => {
  for (const field of ['source', 'target', 'workspace', 'traceId', 'evidenceRefs']) {
    const missing = message();
    delete missing[field];
    const outcome = validateCognitiveMessage(missing);
    assert.equal(outcome.ok, false, `${field} should be required`);
    assert.ok(outcome.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(outcome.errors)}`);
  }
  // An empty evidence list is valid: "no evidence yet" is not a missing field.
  assert.equal(validateCognitiveMessage(message({ evidenceRefs: [] })).ok, true);
});

test('a blank routing field is refused', () => {
  for (const field of ['source', 'target', 'workspace', 'traceId']) {
    assert.deepEqual(codes(validateCognitiveMessage(message({ [field]: '   ' }))), [`VALIDATION_ERROR:${field}`]);
  }
});

test('a missing payload field is an explicit unknown, not an empty placeholder', () => {
  const outcome = validateCognitiveMessage(message({ goal: undefined, hypothesis: null, prediction: null, budget: undefined }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  assert.deepEqual(warningFields(outcome), ['budget', 'goal', 'hypothesis', 'prediction']);
  for (const warning of outcome.warnings) {
    assert.match(warning.message, /explicit unknown/);
  }
});

test('confidence must be a calibrated number in [0, 1] or an explicit unknown', () => {
  assert.equal(validateCognitiveMessage(message({ confidence: 0 })).ok, true);
  assert.equal(validateCognitiveMessage(message({ confidence: 1 })).ok, true);
  for (const bad of [1.01, -0.01, Number.NaN, 'high', true]) {
    assert.deepEqual(codes(validateCognitiveMessage(message({ confidence: bad }))), ['VALIDATION_ERROR:confidence'], String(bad));
  }
  const unknown = validateCognitiveMessage(message({ confidence: null, hypothesis: { text: 'h' } }));
  assert.equal(unknown.ok, true);
  assert.deepEqual(warningFields(unknown), ['confidence']);
});

test('payload content must survive JSON unchanged', () => {
  for (const content of [{ n: 10n }, () => 1, { f: () => 1 }, { n: Infinity }, [Number.NaN], { u: undefined },
    new Date(NOW), new Array(1), { [Symbol('s')]: 1 }, Object.defineProperty({}, 'hidden', { value: 1 }),
    Object.defineProperty({}, 'g', { get: () => 1, enumerable: true })]) {
    assert.deepEqual(codes(validateCognitiveMessage(message({ observation: content }))), ['VALIDATION_ERROR:observation'], String(content));
  }
  for (const content of ['text', 0, false, [1, 'a', null], { nested: { list: [1.5, true] } }]) {
    assert.equal(validateCognitiveMessage(message({ observation: content })).ok, true, JSON.stringify(content));
  }
});

test('evidenceRefs are non-empty strings and cannot repeat', () => {
  assert.deepEqual(codes(validateCognitiveMessage(message({ evidenceRefs: ['ref-1', ''] }))), ['VALIDATION_ERROR:evidenceRefs[1]']);
  assert.deepEqual(codes(validateCognitiveMessage(message({ evidenceRefs: ['ref-1', 'ref-1'] }))),
    [`${COGNITIVE_MESSAGE_ERROR_CODES.DUPLICATE_EVIDENCE_REF}:evidenceRefs[1]`]);
  assert.deepEqual(codes(validateCognitiveMessage(message({ evidenceRefs: 'ref-1' }))), ['VALIDATION_ERROR:evidenceRefs']);
});

test('a non-object message is refused', () => {
  assert.deepEqual(codes(validateCognitiveMessage(null)), [`${COGNITIVE_MESSAGE_ERROR_CODES.INVALID_MESSAGE}:`]);
});

test('a full reference frame validates', () => {
  const outcome = validateReferenceFrame(frame());
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  assert.equal(outcome.type, REFERENCE_FRAME_TYPE);
});

test('every frame field is required and time must be parseable', () => {
  for (const field of REFERENCE_FRAME_FIELDS) {
    const missing = frame();
    delete missing[field];
    const outcome = validateReferenceFrame(missing);
    assert.equal(outcome.ok, false, `${field} should be required`);
    assert.ok(outcome.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(outcome.errors)}`);
  }
  assert.deepEqual(codes(validateReferenceFrame(frame({ time: 'not-a-time' }))), ['VALIDATION_ERROR:time']);
  assert.deepEqual(codes(validateReferenceFrame(null)), [`${COGNITIVE_MESSAGE_ERROR_CODES.INVALID_FRAME}:`]);
});

test('identical frames match and may merge', () => {
  const outcome = compareReferenceFrames(frame(), frame());
  assert.equal(outcome.status, FRAME_COMPARISON_STATUS.MATCH);
  assert.equal(outcome.code, FRAME_COMPARISON_CODES.MATCH);
  assert.equal(outcome.requiresReview, false);
  assert.equal(outcome.mergeAllowed, true);
  assert.deepEqual(outcome.mismatched, []);
  assert.deepEqual(outcome.unresolved, []);
  assert.ok(REFERENCE_FRAME_FIELDS.every((f) => outcome.fields[f] === FRAME_COMPARISON_STATUS.MATCH));
});

test('a differing frame field is a mismatch that forbids a silent merge', () => {
  const outcome = compareReferenceFrames(frame(), frame({ branch: 'dev', commit: 'deadbeef' }));
  assert.equal(outcome.status, FRAME_COMPARISON_STATUS.MISMATCH);
  assert.equal(outcome.code, FRAME_COMPARISON_CODES.MISMATCH);
  assert.equal(outcome.requiresReview, true);
  assert.equal(outcome.mergeAllowed, false);
  assert.deepEqual(outcome.mismatched, ['branch', 'commit']);
  assert.deepEqual(outcome.unresolved, []);
});

test('a field missing on either side is unknown, never assumed equal', () => {
  const outcome = compareReferenceFrames(frame(), frame({ task: undefined }));
  assert.equal(outcome.status, FRAME_COMPARISON_STATUS.UNKNOWN);
  assert.equal(outcome.code, FRAME_COMPARISON_CODES.UNKNOWN);
  assert.equal(outcome.requiresReview, true);
  assert.equal(outcome.mergeAllowed, false);
  assert.deepEqual(outcome.mismatched, []);
  assert.deepEqual(outcome.unresolved, ['task']);

  // A mismatch outranks an unknown: a definite difference is reported even when
  // another field is unresolved.
  const mixed = compareReferenceFrames(frame(), frame({ branch: 'dev', actor: null }));
  assert.equal(mixed.status, FRAME_COMPARISON_STATUS.MISMATCH);
  assert.deepEqual(mixed.mismatched, ['branch']);
  assert.deepEqual(mixed.unresolved, ['actor']);
});

test('an invalid frame yields an undecidable comparison, not a false match', () => {
  const outcome = compareReferenceFrames(frame(), 'not-a-frame');
  assert.equal(outcome.status, FRAME_COMPARISON_STATUS.UNKNOWN);
  assert.equal(outcome.code, FRAME_COMPARISON_CODES.INVALID);
  assert.equal(outcome.mergeAllowed, false);
  assert.equal(outcome.requiresReview, true);
  assert.equal(outcome.unresolved.length, REFERENCE_FRAME_FIELDS.length);
});

test('comparison results are frozen so a caller cannot rewrite a verdict', () => {
  const outcome = compareReferenceFrames(frame(), frame());
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.fields), true);
  assert.throws(() => { outcome.status = 'mismatch'; }, TypeError);
});
