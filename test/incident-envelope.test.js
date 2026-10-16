'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INCIDENT_ENVELOPE_VERSION,
  INCIDENT_CLASSES,
  buildIncidentEnvelope,
  verifyIncidentEnvelope,
} = require('../lib/incident-envelope');

function input(overrides = {}) {
  return {
    incidentId: 'INC-2026-001',
    eventTimes: { occurredAt: '2026-01-01T00:00:00.000Z', detectedAt: '2026-01-01T01:00:00.000Z' },
    reporterAuthority: 'authority:deployer-a',
    recipientAuthority: 'authority:response-team',
    class: 'cyber',
    severity: 'high',
    affectedScope: 'workspace-a',
    evidenceHash: 'f'.repeat(64),
    containmentStatus: 'contained',
    contactChannel: 'ops-channel-1',
    disclosureBasis: 'contract-7 incident clause',
    ...overrides,
  };
}

test('a complete envelope builds, binds and verifies', () => {
  const record = buildIncidentEnvelope(input());
  assert.equal(record.version, INCIDENT_ENVELOPE_VERSION);
  assert.match(record.incidentId, /^incident:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(record));
  assert.deepEqual(verifyIncidentEnvelope(record), { valid: true, reason: null });
  assert.deepEqual(INCIDENT_CLASSES, ['cyber', 'biological', 'other']);
});

test('edits break the binding and malformed envelopes never build', () => {
  const record = buildIncidentEnvelope(input());
  assert.equal(verifyIncidentEnvelope({ ...record, severity: 'low' }).reason, 'binding_mismatch');
  assert.equal(verifyIncidentEnvelope(null).reason, 'envelope_malformed');
  for (const bad of [
    input({ class: 'gossip' }),
    input({ severity: '' }),
    input({ eventTimes: {} }),
    input({ eventTimes: { detectedAt: 'soon' } }),
    input({ recipientAuthority: '  ' }),
    input({ correctionOf: 42 }),
  ]) {
    assert.throws(() => buildIncidentEnvelope(bad), /class|severity|detectedAt|recipientAuthority|correctionOf|required|valid instant|must be one of/);
  }
});

test('corrections supersede through correctionOf without rewriting history', () => {
  const first = buildIncidentEnvelope(input());
  const second = buildIncidentEnvelope(input({ incidentId: 'INC-2026-002', correctionOf: first.incidentId }));
  assert.equal(second.correctionOf, first.incidentId);
  assert.notEqual(second.incidentId, first.incidentId);
  assert.deepEqual(verifyIncidentEnvelope(second), { valid: true, reason: null });
});
