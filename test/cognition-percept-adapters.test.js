'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RECEIPT_FIELDS,
  fromFileEffect,
  fromBrowserReceipt,
  fromStepReport,
  fromPredictionError,
  fromOutcomePair,
} = require('../lib/cognition/percept-adapters');
const { validateCognitiveMessage } = require('../lib/memory-cognitive-message');

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

test('fromFileEffect yields an observed percept for a measured effect', () => {
  const percept = fromFileEffect({
    fileEffect: { observation: 'modified' },
    path: 'src/a.js',
    frame: frame(),
    traceId: 'agent-run-1:step-3',
    observedAt: '2026-10-19T10:00:00Z',
  });
  assert.equal(percept.status, 'MEASURED');
  assert.equal(percept.modality, 'file-effect');
  assert.equal(percept.provenance, 'observed');
  assert.equal(percept.message.observation.effect, 'modified');
  assert.equal(validateCognitiveMessage(percept.message).ok, true);
});

test('fromFileEffect abstains on an indeterminate effect instead of observing it', () => {
  const percept = fromFileEffect({ fileEffect: { observation: 'indeterminate' }, path: 'src/a.js', traceId: 't:1' });
  assert.equal(percept.status, 'ABSTAIN');
  assert.equal(percept.reason, 'unobserved_effect');
  assert.equal(percept.authority, 'OBSERVATION_ONLY');
});

test('fromStepReport is always reported and can never be observed', () => {
  const percept = fromStepReport({ report: { step: 'edit', status: 'ok' }, frame: frame(), traceId: 't:1' });
  assert.equal(percept.status, 'MEASURED');
  assert.equal(percept.modality, 'step-report');
  assert.equal(percept.provenance, 'reported');
});

test('fromBrowserReceipt copies only hashed/classified fields, never a raw URL', () => {
  const receipt = {
    receiptId: 'browser_evt_abc',
    receiptHash: 'deadbeef',
    receiptKind: 'browser_session_event_receipt',
    metadata: {
      sessionId: 'sess-1',
      event: 'navigate',
      destination: 'https://example.com/secret?token=xyz',
      targetIdHash: 'a'.repeat(64),
      method: 'GET',
      statusCode: 200,
    },
  };
  const percept = fromBrowserReceipt({ receipt, frame: frame(), traceId: 't:1' });
  assert.equal(percept.status, 'MEASURED');
  assert.equal(percept.provenance, 'observed');
  assert.equal(percept.message.observation.event, 'navigate');
  assert.equal(percept.message.observation.targetIdHash, 'a'.repeat(64));
  assert.equal(percept.message.observation.destination, undefined);
  const rawDestination = receipt.metadata.destination;
  const carried = Object.values(percept.message.observation);
  assert.ok(!carried.includes(rawDestination), 'raw destination leaked into the percept');
  for (const key of Object.keys(percept.message.observation)) assert.ok(RECEIPT_FIELDS.includes(key));
});

test('fromBrowserReceipt abstains on a receipt of the wrong kind', () => {
  const percept = fromBrowserReceipt({ receipt: { receiptId: 'x', receiptKind: 'other' }, traceId: 't:1' });
  assert.equal(percept.status, 'ABSTAIN');
  assert.equal(percept.reason, 'invalid_receipt');
});

test('fromPredictionError is derived, never observed', () => {
  const percept = fromPredictionError({
    error: { kind: 'risk', signedError: -0.4, magnitude: 0.4, decisionId: 'd1' },
    frame: frame(),
    traceId: 't:1',
  });
  assert.equal(percept.status, 'MEASURED');
  assert.equal(percept.modality, 'prediction-error');
  assert.equal(percept.provenance, 'derived');
  assert.equal(percept.message.observation.signedError, -0.4);
});

test('fromOutcomePair observes a decided pair and abstains while censored', () => {
  const decided = fromOutcomePair({
    pair: { decisionId: 'd1', outcome: { state: 'incident', at: '2026-10-19T10:05:00Z' } },
    frame: frame(),
    traceId: 't:1',
  });
  assert.equal(decided.status, 'MEASURED');
  assert.equal(decided.provenance, 'observed');
  assert.equal(decided.message.observation.state, 'incident');

  const censored = fromOutcomePair({ pair: { decisionId: 'd2', outcome: null }, traceId: 't:1' });
  assert.equal(censored.status, 'ABSTAIN');
  assert.equal(censored.reason, 'censored_outcome');
});

test('every adapter result is frozen and carries the shared schema version', () => {
  const percept = fromStepReport({ report: { step: 'edit', status: 'ok' }, traceId: 't:1' });
  assert.equal(percept.schemaVersion, 'huqan-cognition-percept-v1');
  assert.throws(() => { percept.provenance = 'observed'; }, TypeError);
});
