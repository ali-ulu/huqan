'use strict';

// #2219: human oversight runtime versions, decision types, case statuses,
// limits and reasons, and the bounded text, reference and metadata values.

// The primitives' only edge to receipt/canonical-receipt.js: the normalize
// part takes both hashing helpers from here.
const { stableStringify, sha256Hex } = require('./receipt/canonical-receipt');
const { isPlainObject } = require('./is-plain-object');

const HUMAN_OVERSIGHT_RUNTIME_VERSION = 'human-oversight-approval-runtime-v1';
const REVIEW_CASE_SCHEMA_VERSION = 'huqan-review-case-v1';
const APPROVAL_DECISION_SCHEMA_VERSION = 'huqan-approval-decision-v1';
const STATE_RECORD_SCHEMA_VERSION = 'huqan-human-oversight-state-v1';

const DECISION_TYPES = Object.freeze([
  'approve',
  'reject',
  'expire',
  'cancel',
  'escalate',
  'override',
]);

const CASE_STATUSES = Object.freeze([
  'pending',
  'escalated',
  'approved',
  // Durable execution claim held between authorization and the recorded
  // outcome. Only `approved` authorizes, so a second concurrent execution
  // finds this instead and fails closed (#1867).
  'executing',
  'rejected',
  'expired',
  'cancelled',
  'blocked',
  'executed',
  'reconciliation_required',
]);

const EXECUTION_OUTCOMES = Object.freeze([
  'not_attempted',
  'dry_run_only',
  'succeeded',
  'failed',
  'unknown',
]);

const MAX_TEXT = 512;
const MAX_REASON = 1024;
const MAX_REFS = 32;
const MAX_HISTORY = 128;
const MAX_METADATA_BYTES = 4096;
const DEFAULT_CASE_LIFETIME_MS = 15 * 60 * 1000;
const MAX_CASE_LIFETIME_MS = 24 * 60 * 60 * 1000;

const RUNTIME_REASONS = Object.freeze({
  DURABILITY_UNAVAILABLE: 'approval.durable_state_unavailable',
  CASE_NOT_FOUND: 'approval.case_not_found',
  CASE_IMMUTABLE_MISMATCH: 'approval.case_immutable_mismatch',
  MALFORMED_CASE: 'approval.case_malformed',
  MALFORMED_DECISION: 'approval.decision_malformed',
  DECISION_REASON_REQUIRED: 'approval.decision_reason_required',
  APPROVER_IDENTITY_REQUIRED: 'approval.approver_identity_required',
  REQUESTER_IDENTITY_REQUIRED: 'approval.requester_identity_required',
  IDENTITY_REJECTED: 'approval.identity_rejected',
  SELF_APPROVAL_REJECTED: 'approval.self_approval_rejected',
  SCOPE_MISMATCH: 'approval.scope_mismatch',
  POLICY_MISMATCH: 'approval.policy_mismatch',
  FIREWALL_MISMATCH: 'approval.firewall_mismatch',
  ACTION_MISMATCH: 'approval.action_mismatch',
  CASE_EXPIRED: 'approval.case_expired',
  CASE_NOT_PENDING: 'approval.case_not_pending',
  DUPLICATE_OR_AMBIGUOUS_DECISION: 'approval.duplicate_or_ambiguous_decision',
  OVERRIDE_NOT_AUTHORIZED: 'approval.override_not_authorized',
  BLOCKED_BY_FIREWALL: 'approval.firewall_blocked',
  DRY_RUN_EXECUTOR_BLOCKED: 'approval.dry_run_executor_blocked',
  APPROVAL_REQUIRED: 'approval.valid_approval_required',
  EXECUTION_RECORDED_AS_UNKNOWN: 'approval.execution_outcome_unknown',
  EXECUTION_RECONCILIATION_REQUIRED: 'approval.execution_reconciliation_required',
  EXECUTION_ALREADY_RESERVED: 'approval.execution_already_reserved',
  RESOLVER_FAILED: 'approval.identity_resolver_failed',
  FIREWALL_EVALUATION_FAILED: 'approval.firewall_evaluation_failed',
  APPROVAL_COOLDOWN_ACTIVE: 'approval.cooldown_active',
  QUORUM_DISTINCT_APPROVER_REQUIRED: 'approval.quorum_distinct_approver_required',
});


function cloneJson(value, field) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    throw new TypeError(`${field} must be JSON-serializable`);
  }
}

function boundedText(value, field, { required = false, max = MAX_TEXT } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new TypeError(`${field} is required`);
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  return normalized;
}

function boundedRefs(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REFS) throw new TypeError(`${field} must be a bounded array`);
  return value.map((item, index) => boundedText(item, `${field}[${index}]`));
}

function safeMetadata(value) {
  const metadata = value === undefined ? {} : cloneJson(value, 'metadata');
  if (!isPlainObject(metadata)) throw new TypeError('metadata must be an object');
  const forbidden = /prompt|input|content|token|secret|credential|password|private.?key/i;
  function visit(node, depth, path) {
    if (depth > 4) throw new TypeError(`${path} exceeds nested depth`);
    if (Array.isArray(node)) {
      if (node.length > MAX_REFS) throw new TypeError(`${path} exceeds bounded array length`);
      node.forEach((child, index) => visit(child, depth + 1, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.test(key)) throw new TypeError(`forbidden metadata field: ${path}.${key}`);
      visit(child, depth + 1, `${path}.${key}`);
    }
  }
  visit(metadata, 0, 'metadata');
  if (Buffer.byteLength(stableStringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
    throw new TypeError('metadata exceeds bounded size');
  }
  return metadata;
}

module.exports = {
  sha256Hex,
  stableStringify,
  APPROVAL_DECISION_SCHEMA_VERSION,
  CASE_STATUSES,
  DECISION_TYPES,
  DEFAULT_CASE_LIFETIME_MS,
  EXECUTION_OUTCOMES,
  HUMAN_OVERSIGHT_RUNTIME_VERSION,
  MAX_CASE_LIFETIME_MS,
  MAX_HISTORY,
  MAX_METADATA_BYTES,
  MAX_REASON,
  MAX_REFS,
  MAX_TEXT,
  REVIEW_CASE_SCHEMA_VERSION,
  RUNTIME_REASONS,
  STATE_RECORD_SCHEMA_VERSION,
  boundedRefs,
  boundedText,
  cloneJson,
  safeMetadata,
};
