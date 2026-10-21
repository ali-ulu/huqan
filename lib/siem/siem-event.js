'use strict';

/**
 * SIEM event mapper for the external-action guard's receipts (#4093, PR-B1).
 *
 * The scope note (issue #4093, section 3.1) fixes a canonical event,
 * `huqan.siem-event.v1`, as the one shape every SIEM format is rendered from.
 * This module is that shape: it maps one admission receipt onto one event, and
 * it maps nothing else. The ECS, Splunk HEC and CEF formatters that render the
 * event are a separate slice (PR-B2); the sink and cursor that move it are
 * another (PR-B3).
 *
 * What an event may carry is an allowlist, not a redaction of the receipt.
 * The receipt holds raw tool arguments, the full target file path and the
 * host's own unattested statement about itself (`hostContext`); none of those
 * leave this module. INV-B2 of the scope note: a field outside the allowlist
 * does not reach the output, however the caller shaped the receipt.
 *
 * A SIEM record is not an evidence record. The event points at the evidence --
 * `event.id` is the receipt id and `huqan.receipt.hash` is the receipt hash --
 * and never claims to replace it. Redaction is therefore free here: the event
 * is not bound to the receipt's hash, so PII and secrets the receipt happens
 * to carry in a free-text field are scrubbed by the same egress gate the live
 * path uses (AB9), and `huqan.redacted` records that it happened.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. The receipt's own
 * `createdAt` becomes `@timestamp`.
 */

const { evaluateEgress } = require('../data-egress-gate');

const SIEM_EVENT_SCHEMA_VERSION = 'huqan.siem-event.v1';

const SIEM_ERRORS = Object.freeze({
  INVALID_RECEIPT: 'SIEM_INVALID_RECEIPT',
  UNSUPPORTED_RECEIPT_KIND: 'SIEM_UNSUPPORTED_RECEIPT_KIND',
});

// The exact key set a `huqan.siem-event.v1` carries. Exported so a formatter
// (PR-B2) and a test can pin the same set this mapper produces. `huqan.destination.host`
// is the one optional member: a receipt that named no safe destination says
// nothing rather than inventing a host.
const SIEM_EVENT_FIELDS = Object.freeze([
  'event.id',
  'event.kind',
  'event.action',
  'event.outcome',
  '@timestamp',
  'huqan.receipt.hash',
  'huqan.receipt.kind',
  'huqan.decision',
  'huqan.reason',
  'huqan.risk_score',
  'huqan.rule.id',
  'huqan.policy_version',
  'huqan.agent.id',
  'huqan.agent.name',
  'huqan.workspace_id',
  'huqan.tool.name',
  'huqan.tool.kind',
  'huqan.findings',
  'huqan.destination.host',
  'huqan.input_digest',
  'huqan.redacted',
  'huqan.schema_version',
]);

// Receipt kind to the event action vocabulary the scope note fixes. A kind
// that is not an admission receipt is refused, never guessed: an outcome or a
// review receipt describes a different moment, and folding it into this shape
// would put two different facts under one action.
const ACTION_BY_RECEIPT_KIND = Object.freeze({
  external_action_admission_receipt: 'admit',
  external_action_review_receipt: 'review',
  external_action_rejection_receipt: 'block',
});

const EVENT_KIND = 'external_action';

function siemError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function boundedRiskScore(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function receiptMetadata(receipt) {
  const metadata = receipt.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

/**
 * The allowlisted finding projection. A finding names which gate spoke, what
 * it decided and why, and the PII types it saw -- the same fields the scope
 * note lists. Everything else a `safeFinding` may carry (canary fingerprints,
 * destinations, gate detail) stays on the receipt.
 */
function projectFindings(findings) {
  if (!Array.isArray(findings)) return [];
  return findings.map((finding) => {
    const source = finding && typeof finding === 'object' ? finding : {};
    return {
      gate: boundedString(source.gate),
      decision: boundedString(source.decision),
      reason: boundedString(source.reason),
      pii_types: Array.isArray(source.piiTypes) ? source.piiTypes.map(String) : [],
    };
  });
}

/**
 * Maps one admission receipt to one frozen `huqan.siem-event.v1`.
 *
 * The event is assembled first, then passed through the egress gate, so the
 * scrubbing covers every string the event carries -- reason, tool name, agent
 * name -- and `huqan.redacted` is set from what the gate actually found rather
 * than from a promise that the receipt was clean.
 */
function receiptToSiemEvent(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw siemError(SIEM_ERRORS.INVALID_RECEIPT, 'SIEM mapping requires a receipt object');
  }
  // A receipt is identified by its own id and kind. Without either, the input
  // is not a receipt at all -- a different failure from a receipt whose kind
  // this mapper does not render, which is refused by its own code below.
  const kind = boundedString(receipt.receiptKind);
  if (!boundedString(receipt.receiptId) || !kind) {
    throw siemError(SIEM_ERRORS.INVALID_RECEIPT, 'SIEM mapping requires a receipt id and kind');
  }
  const action = ACTION_BY_RECEIPT_KIND[kind];
  if (!action) {
    throw siemError(SIEM_ERRORS.UNSUPPORTED_RECEIPT_KIND, `not an admission receipt kind: ${kind}`);
  }
  const metadata = receiptMetadata(receipt);
  const ruleIdentity = metadata.ruleIdentity && typeof metadata.ruleIdentity === 'object' ? metadata.ruleIdentity : {};
  const destination = metadata.destination && typeof metadata.destination === 'object' ? metadata.destination : null;

  const event = {
    'event.id': boundedString(receipt.receiptId),
    'event.kind': EVENT_KIND,
    'event.action': action,
    'event.outcome': boundedString(receipt.status),
    '@timestamp': boundedString(receipt.createdAt),
    'huqan.receipt.hash': boundedString(receipt.receiptHash),
    'huqan.receipt.kind': kind,
    'huqan.decision': boundedString(receipt.decision),
    'huqan.reason': boundedString(receipt.reason),
    'huqan.risk_score': boundedRiskScore(receipt.riskScore),
    'huqan.rule.id': boundedString(ruleIdentity.ruleId),
    'huqan.policy_version': boundedString(receipt.trustPolicyVersion),
    'huqan.agent.id': boundedString(receipt.agentId),
    'huqan.agent.name': boundedString(metadata.agentName) || boundedString(receipt.actor),
    'huqan.workspace_id': boundedString(receipt.workspaceId),
    'huqan.tool.name': boundedString(metadata.toolName),
    'huqan.tool.kind': boundedString(metadata.toolKind),
    'huqan.findings': projectFindings(metadata.findings),
    'huqan.input_digest': boundedString(metadata.inputDigest),
    'huqan.redacted': false,
    'huqan.schema_version': SIEM_EVENT_SCHEMA_VERSION,
  };
  // Host only: the scheme and path a browser action carried stay on the
  // receipt, because the host is the answer to "where did the data go".
  if (destination && boundedString(destination.host)) {
    event['huqan.destination.host'] = boundedString(destination.host);
  }

  const scrubbed = evaluateEgress(event);
  return Object.freeze({
    ...scrubbed.scrubbed,
    'huqan.redacted': scrubbed.piiDetected || scrubbed.secretDetected,
  });
}

module.exports = {
  SIEM_EVENT_SCHEMA_VERSION,
  SIEM_ERRORS,
  SIEM_EVENT_FIELDS,
  ACTION_BY_RECEIPT_KIND,
  receiptToSiemEvent,
};
