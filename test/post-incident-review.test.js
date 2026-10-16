'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const {
  POST_INCIDENT_OPERATION_PREFIX,
  normalizeResponsibility,
} = require('../lib/post-incident-review');
const {
  recordPostIncidentReview,
  readPostIncidentReviews,
} = require('../lib/post-action-monitor');
const {
  INCIDENT_ENVELOPE_VERSION,
  verifyIncidentEnvelope,
} = require('../lib/incident-envelope');

function graphIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-post-incident-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

function responsibility() {
  return {
    company: { status: 'assigned', ref: 'org:huqan' },
    developer: { status: 'assigned', ref: 'developer:team-security' },
    user: { status: 'unassigned' },
    agentIdentity: { status: 'assigned', ref: 'agent:incident-agent' },
  };
}

test('post-incident review is durable and carries all four responsibility roles', (t) => {
  const graph = graphIn(t);
  const recorded = recordPostIncidentReview({
    graph,
    workspaceId: 'workspace-a',
    incidentId: 'incident-42',
    reviewId: 'review-1',
    responsibility: responsibility(),
    rootCauseRef: 'root-cause:42',
    correctiveActionRefs: ['action:patch-1', 'action:test-2'],
    sourceRefs: ['receipt:xact-1'],
    createdAt: '2026-09-22T12:00:00.000Z',
  });

  assert.equal(recorded.replayed, false);
  assert.equal(recorded.verification.valid, true);
  assert.equal(recorded.receipt.canonicalPayload.reason, 'post_incident_review_recorded');
  assert.equal(recorded.receipt.canonicalPayload.metadata.responsibility.company.ref, 'org:huqan');

  const rows = readPostIncidentReviews(graph);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].operationId.startsWith(POST_INCIDENT_OPERATION_PREFIX));
  assert.deepEqual(Object.keys(rows[0].responsibility).sort(), ['agentIdentity', 'company', 'developer', 'user']);
  assert.equal(rows[0].responsibility.user.status, 'unassigned');
});

test('every responsibility role is explicit; missing roles fail closed', () => {
  assert.throws(() => normalizeResponsibility({
    company: { status: 'assigned', ref: 'org:huqan' },
    developer: { status: 'assigned', ref: 'developer:security' },
    user: { status: 'unassigned' },
  }), /responsibility\.agentIdentity is required/);
});

test('assigned responsibility requires a bounded ref', () => {
  const input = responsibility();
  input.user = { status: 'assigned' };
  assert.throws(() => normalizeResponsibility(input), /responsibility\.user\.ref is required when assigned/);
});

test('unassigned and not-applicable states cannot smuggle an assignment ref', () => {
  const input = responsibility();
  input.user = { status: 'unassigned', ref: 'user:hidden' };
  assert.throws(() => normalizeResponsibility(input), /must be empty unless assigned/);
});

test('the same workspace, incident and review id replays instead of duplicating the record', (t) => {
  const graph = graphIn(t);
  const input = {
    graph,
    workspaceId: 'workspace-a',
    incidentId: 'incident-42',
    reviewId: 'review-1',
    responsibility: responsibility(),
    createdAt: '2026-09-22T12:00:00.000Z',
  };
  assert.equal(recordPostIncidentReview(input).replayed, false);
  assert.equal(recordPostIncidentReview(input).replayed, true);
  assert.equal(readPostIncidentReviews(graph).length, 1);
});

test('unknown responsibility roles are rejected instead of silently persisted', () => {
  assert.throws(() => normalizeResponsibility({
    ...responsibility(),
    vendor: { status: 'assigned', ref: 'vendor:x' },
  }), /unknown responsibility role: vendor/);
});

test('recording a review builds a private incident envelope that survives read-back', (t) => {
  const graph = graphIn(t);
  const recorded = recordPostIncidentReview({
    graph,
    workspaceId: 'workspace-a',
    incidentId: 'incident-42',
    reviewId: 'review-envelope',
    responsibility: responsibility(),
    rootCauseRef: 'root-cause:42',
    correctiveActionRefs: ['action:patch-1'],
    sourceRefs: ['receipt:xact-1'],
    incidentEnvelope: {
      class: 'cyber',
      severity: 'high',
      containmentStatus: 'contained',
      eventTimes: { occurredAt: '2026-09-22T11:00:00.000Z' },
    },
    createdAt: '2026-09-22T12:00:00.000Z',
  });
  assert.equal(recorded.replayed, false);

  const rows = readPostIncidentReviews(graph);
  assert.equal(rows.length, 1);
  const envelope = rows[0].incidentEnvelope;
  assert.equal(envelope.version, INCIDENT_ENVELOPE_VERSION);
  assert.equal(envelope.class, 'cyber');
  assert.equal(envelope.severity, 'high');
  assert.equal(envelope.containmentStatus, 'contained');
  // Detected time falls back to when the review was recorded; the occurrence
  // comes from the caller. Neither is invented.
  assert.equal(envelope.eventTimes.occurredAt, '2026-09-22T11:00:00.000Z');
  assert.equal(envelope.eventTimes.detectedAt, '2026-09-22T12:00:00.000Z');
  // The proof refs the review already carries are bound into the envelope; the
  // source content itself is never a field.
  assert.match(envelope.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(envelope, 'sourceRefs'), false);
  assert.deepEqual(verifyIncidentEnvelope(envelope), { valid: true, reason: null });
});

test('a tampered envelope read back from the review fails verification', (t) => {
  const graph = graphIn(t);
  recordPostIncidentReview({
    graph,
    workspaceId: 'workspace-a',
    incidentId: 'incident-42',
    reviewId: 'review-tamper',
    responsibility: responsibility(),
    incidentEnvelope: { class: 'cyber', severity: 'high' },
    createdAt: '2026-09-22T12:00:00.000Z',
  });

  const envelope = readPostIncidentReviews(graph)[0].incidentEnvelope;
  const tampered = { ...envelope, severity: 'low' };
  assert.equal(verifyIncidentEnvelope(tampered).reason, 'binding_mismatch');
  assert.equal(verifyIncidentEnvelope({ ...envelope, incidentId: 'incident:forged' }).reason, 'binding_mismatch');
});

test('a review records an explicit unknown when the caller classifies nothing', (t) => {
  const graph = graphIn(t);
  recordPostIncidentReview({
    graph,
    workspaceId: 'workspace-a',
    incidentId: 'incident-42',
    reviewId: 'review-unclassified',
    responsibility: responsibility(),
    createdAt: '2026-09-22T12:00:00.000Z',
  });

  const envelope = readPostIncidentReviews(graph)[0].incidentEnvelope;
  // Unclassified is recorded as "other"/"unknown", never silently upgraded to a
  // real class, and the envelope is still content-bound and verifiable.
  assert.equal(envelope.class, 'other');
  assert.equal(envelope.severity, 'unknown');
  assert.equal(envelope.evidenceHash, 'none');
  assert.deepEqual(verifyIncidentEnvelope(envelope), { valid: true, reason: null });
});
