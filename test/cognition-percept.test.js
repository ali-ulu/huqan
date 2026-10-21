'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_OBSERVATION_BYTES,
  buildPercept,
  perceptKeyOf,
} = require('../lib/cognition/percept');
const { validateCognitiveMessage } = require('../lib/memory-cognitive-message');

const message = (observation = { path: 'src/a.js', effect: 'unchanged' }, extra = {}) => ({
  source: 'file-effect-sensor',
  target: 'cognition',
  workspace: 'default',
  goal: null,
  observation,
  prediction: null,
  hypothesis: null,
  action: null,
  confidence: null,
  evidenceRefs: ['receipt:r_12'],
  temporalContext: { observedAt: '2026-10-19T10:00:00Z' },
  budget: null,
  traceId: 'agent-run-1:step-3',
  ...extra,
});

const frame = () => ({
  repo: 'huqan',
  branch: 'main',
  commit: 'abc123',
  environment: 'test',
  actor: 'agent',
  time: '2026-10-19T10:00:00Z',
  goal: 'g',
  task: 't',
});

const fileEffect = (extra = {}) => buildPercept({
  modality: 'file-effect',
  provenance: 'observed',
  message: message(),
  frame: frame(),
  ...extra,
});

test('builds a percept that passes validateCognitiveMessage', () => {
  const percept = fileEffect();
  assert.equal(percept.status, 'MEASURED');
  assert.equal(percept.schemaVersion, 'huqan-cognition-percept-v1');
  assert.equal(percept.modality, 'file-effect');
  assert.equal(percept.provenance, 'observed');
  assert.equal(percept.authority, 'OBSERVATION_ONLY');
  assert.match(percept.perceptId, /^pc_[0-9a-f]{24}$/);
  assert.match(percept.perceptKey, /^pk_[0-9a-f]{24}$/);
  assert.equal(validateCognitiveMessage(percept.message).ok, true);
});

test('marks step report percepts as reported, never observed', () => {
  const reported = buildPercept({ modality: 'step-report', provenance: 'reported', message: message({}, { source: 'step' }), frame: frame() });
  assert.equal(reported.status, 'MEASURED');
  assert.equal(reported.provenance, 'reported');

  const upgraded = buildPercept({ modality: 'step-report', provenance: 'observed', message: message({}, { source: 'step' }), frame: frame() });
  assert.equal(upgraded.status, 'REJECT');
  assert.equal(upgraded.reason, 'provenance_not_allowed:step-report');
});

test('perceptKey ignores traceId and timestamps', () => {
  const a = fileEffect();
  const b = fileEffect({
    message: message(undefined, { traceId: 'agent-run-9:step-77', temporalContext: { observedAt: '2030-01-01T00:00:00Z' } }),
    frame: { ...frame(), time: '2030-01-01T00:00:00Z' },
  });
  assert.equal(a.perceptKey, b.perceptKey);
  assert.equal(perceptKeyOf({ modality: 'file-effect', message: message(), frame: frame() }), a.perceptKey);
});

test('perceptId changes when observation changes', () => {
  const a = fileEffect();
  const b = fileEffect({ message: message({ path: 'src/b.js', effect: 'modified' }) });
  assert.notEqual(a.perceptId, b.perceptId);
  assert.notEqual(a.perceptKey, b.perceptKey);
});

test('rejects observations above MAX_OBSERVATION_BYTES', () => {
  const huge = message({ path: 'src/a.js', effect: 'unchanged', blob: 'x'.repeat(MAX_OBSERVATION_BYTES) });
  const percept = fileEffect({ message: huge });
  assert.equal(percept.status, 'REJECT');
  assert.equal(percept.reason, 'percept_too_large');
});

test('keeps FIELD_UNKNOWN warnings instead of empty placeholders', () => {
  const percept = fileEffect();
  const fields = percept.validation.warnings.map((warning) => warning.field);
  assert.ok(fields.includes('goal'));
  assert.ok(fields.includes('confidence'));
  assert.ok(!('goal' in percept.message) || percept.message.goal === null);
});

test('rejects an invalid cognitive message and unknown modality', () => {
  const invalid = buildPercept({ modality: 'file-effect', provenance: 'observed', message: { source: 'x' }, frame: frame() });
  assert.equal(invalid.status, 'REJECT');
  assert.equal(invalid.reason, 'invalid_cognitive_message');

  const unknown = fileEffect({ modality: 'telepathy' });
  assert.equal(unknown.status, 'REJECT');
  assert.equal(unknown.reason, 'unknown_modality');
});

test('marks an absent frame as absent and a broken frame as partial', () => {
  const absent = buildPercept({ modality: 'file-effect', provenance: 'observed', message: message(), frame: null });
  assert.equal(absent.frameStatus, 'absent');
  assert.equal(absent.frame, null);

  const partial = fileEffect({ frame: { repo: 'huqan' } });
  assert.equal(partial.frameStatus, 'partial');
});

test('does not mutate its input and freezes the result', () => {
  const input = { modality: 'file-effect', provenance: 'observed', message: message(), frame: frame() };
  const snapshot = JSON.stringify(input);
  const percept = fileEffect(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.throws(() => { percept.provenance = 'reported'; }, TypeError);
});

test('fails closed on a message whose accessor throws instead of escaping', () => {
  const throwing = message();
  Object.defineProperty(throwing, 'observation', {
    enumerable: true,
    get() { throw new Error('getter boom'); },
  });

  const result = buildPercept({ modality: 'file-effect', provenance: 'observed', message: throwing, frame: frame() });
  assert.equal(result.status, 'REJECT');
  assert.equal(result.reason, 'unhashable_input');
});
