'use strict';

const crypto = require('node:crypto');

const { createTrustEvidenceLedger } = require('./trust-evidence-ledger');

const POST_INCIDENT_REVIEW_VERSION = 'huqan-post-incident-review-v1';
const POST_INCIDENT_OPERATION_PREFIX = 'post-incident-review:';
const RESPONSIBILITY_ROLES = Object.freeze(['company', 'developer', 'user', 'agentIdentity']);
const RESPONSIBILITY_STATUSES = Object.freeze(['assigned', 'unassigned', 'not_applicable']);
const RESPONSIBILITY_STATUS_SET = new Set(RESPONSIBILITY_STATUSES);
const MAX_REF_LENGTH = 256;
const MAX_REFS = 16;

function boundedText(value, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new TypeError(`${field} is required`);
  if (normalized.length > MAX_REF_LENGTH) throw new TypeError(`${field} exceeds bounded length`);
  return normalized;
}

function boundedRefs(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REFS) {
    throw new TypeError(`${field} must be a bounded array`);
  }
  return value.map((entry, index) => boundedText(entry, `${field}[${index}]`, true));
}

function normalizeResponsibility(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('responsibility must be a plain object');
  }
  const unknown = Object.keys(input).filter((key) => !RESPONSIBILITY_ROLES.includes(key));
  if (unknown.length > 0) throw new TypeError(`unknown responsibility role: ${unknown[0]}`);

  const normalized = {};
  for (const role of RESPONSIBILITY_ROLES) {
    const assignment = input[role];
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      throw new TypeError(`responsibility.${role} is required`);
    }
    const status = boundedText(assignment.status, `responsibility.${role}.status`, true);
    if (!RESPONSIBILITY_STATUS_SET.has(status)) {
      throw new TypeError(`responsibility.${role}.status is invalid`);
    }
    const ref = boundedText(assignment.ref, `responsibility.${role}.ref`);
    if (status === 'assigned' && !ref) {
      throw new TypeError(`responsibility.${role}.ref is required when assigned`);
    }
    if (status !== 'assigned' && ref) {
      throw new TypeError(`responsibility.${role}.ref must be empty unless assigned`);
    }
    normalized[role] = Object.freeze({ status, ref });
  }
  return Object.freeze(normalized);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function operationIdFor(workspaceId, incidentId, reviewId) {
  return `${POST_INCIDENT_OPERATION_PREFIX}${digest(`${workspaceId}\0${incidentId}\0${reviewId}`).slice(0, 40)}`;
}

function recordPostIncidentReview({
  graph,
  workspaceId,
  incidentId,
  reviewId,
  responsibility,
  rootCauseRef,
  correctiveActionRefs,
  sourceRefs,
  createdAt,
} = {}) {
  if (!graph) throw new TypeError('graph is required');
  const workspace = boundedText(workspaceId, 'workspaceId', true);
  const incident = boundedText(incidentId, 'incidentId', true);
  const review = boundedText(reviewId, 'reviewId', true);
  const assignments = normalizeResponsibility(responsibility);
  const rootCause = boundedText(rootCauseRef, 'rootCauseRef');
  const corrective = boundedRefs(correctiveActionRefs, 'correctiveActionRefs');
  const sources = boundedRefs(sourceRefs, 'sourceRefs');
  const timestamp = createdAt === undefined
    ? new Date().toISOString()
    : boundedText(createdAt, 'createdAt', true);
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError('createdAt must be an ISO-compatible timestamp');

  const reviewRecord = Object.freeze({
    schemaVersion: POST_INCIDENT_REVIEW_VERSION,
    incidentId: incident,
    reviewId: review,
    workspaceId: workspace,
    responsibility: assignments,
    rootCauseRef: rootCause,
    correctiveActionRefs: Object.freeze(corrective),
    sourceRefs: Object.freeze(sources),
    createdAt: timestamp,
  });

  // Field and role order are fixed by construction, so this projection is
  // deterministic without reaching from Core into the receipt/Application
  // layer merely for a serialization helper.
  const actionFingerprint = digest(JSON.stringify({
    incidentId: incident,
    reviewId: review,
    responsibility: assignments,
    rootCauseRef: rootCause,
    correctiveActionRefs: corrective,
  }));

  const ledger = createTrustEvidenceLedger({ graph });
  return ledger.append({
    operationId: operationIdFor(workspace, incident, review),
    event: {
      workspaceId: workspace,
      decision: 'review',
      reason: 'post_incident_review_recorded',
      actionFingerprint,
      identityRef: assignments.agentIdentity.status === 'assigned' ? assignments.agentIdentity.ref : '',
      policyVersion: POST_INCIDENT_REVIEW_VERSION,
      resourceRef: `incident:${incident}`,
      sourceRefs: sources,
      createdAt: timestamp,
      metadata: {
        incidentId: incident,
        reviewId: review,
        responsibility: assignments,
        rootCauseRef: rootCause,
        correctiveActionRefs: corrective,
      },
    },
    mutate: () => ({ postIncidentReview: true, review: reviewRecord }),
  });
}

function readPostIncidentReviews(graph) {
  if (!graph || typeof graph.getCommittedMutationResultsByPrefix !== 'function') return [];
  const rows = graph.getCommittedMutationResultsByPrefix(POST_INCIDENT_OPERATION_PREFIX);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row?.result?.postIncidentReview === true && row.result.review)
    .map((row) => Object.freeze({
      operationId: boundedText(row.operationId, 'operationId'),
      ...row.result.review,
    }));
}

module.exports = Object.freeze({
  POST_INCIDENT_REVIEW_VERSION,
  POST_INCIDENT_OPERATION_PREFIX,
  RESPONSIBILITY_ROLES,
  RESPONSIBILITY_STATUSES,
  normalizeResponsibility,
  recordPostIncidentReview,
  readPostIncidentReviews,
});
