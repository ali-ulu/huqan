// Memory admission vocabulary, policy constants and the small normalisers the
// request, receipt and evaluation modules share, moved out of
// memory-admission-gate.js (#2184).

const crypto = require('crypto');

const { APPROVAL_REQUEST_STATUSES } = require('./approval-schema');

const MEMORY_ADMISSION_DECISIONS = Object.freeze([
  'allow',
  'review',
  'reject',
  'quarantine',
]);

const MEMORY_ADMISSION_RECEIPT_KINDS = Object.freeze([
  'memory_admission_receipt',
  'memory_review_receipt',
  'memory_rejection_receipt',
  'memory_quarantine_receipt',
]);

const MEMORY_ADMISSION_POLICY_VERSION = 'V3-PR4-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';
const DECISION_SEVERITY = Object.freeze({ allow: 0, review: 1, quarantine: 2, reject: 3 });

const { isPlainObject } = require('./is-plain-object');
const { cloneJson: clone } = require('./json-clone');

function trimText(value, fallback = '') {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function clampScore(value, fallback = 0) {
  const score = Number(value);
  if (!Number.isFinite(score)) return fallback;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function pushError(errors, field, message, code = 'VALIDATION_ERROR') {
  errors.push({ code, field, message });
}

function makeAdmissionId(request) {
  const basis = [
    request.workspaceId || DEFAULT_WORKSPACE_ID,
    request.agentId || '',
    request.actor || '',
    request.memoryDraftId || '',
    request.provenanceId || '',
    request.reason || '',
    request.createdAt || '',
  ].join('|');
  // sha256 + 32 hex chars (128 bits) instead of sha1 + 16 hex chars (64 bits),
  // see #385.
  return `madm_${crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 32)}`;
}

function normalizeDecision(value) {
  const raw = trimText(value, '').toLowerCase();
  return MEMORY_ADMISSION_DECISIONS.includes(raw) ? raw : '';
}

function normalizeDecisionSignals(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((signal) => {
    if (!isPlainObject(signal)) return [];
    const decision = normalizeDecision(signal.decision);
    const reason = trimText(signal.reason);
    return decision && reason ? [{ decision, reason }] : [];
  });
}

function normalizeApprovalStatus(value, approvalRequired = false) {
  const raw = trimText(value, '').toLowerCase();
  if (!raw) return approvalRequired ? 'pending' : 'not_required';
  if (APPROVAL_REQUEST_STATUSES.includes(raw)) return raw;
  if (raw === 'not_required') return raw;
  return '';
}

module.exports = {
  DECISION_SEVERITY,
  DEFAULT_WORKSPACE_ID,
  MEMORY_ADMISSION_DECISIONS,
  MEMORY_ADMISSION_POLICY_VERSION,
  MEMORY_ADMISSION_RECEIPT_KINDS,
  clampScore,
  clone,
  isPlainObject,
  makeAdmissionId,
  normalizeApprovalStatus,
  normalizeDecision,
  normalizeDecisionSignals,
  nowIso,
  pushError,
  trimText,
};
