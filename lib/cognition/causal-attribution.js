'use strict';

/**
 * COG-B (#4392, PR-1): pure causal attribution and specific-repair closure.
 * Core ring: no I/O, no clock, no randomness.
 *
 * agent_executed is not agent_caused. Execution evidence alone cannot blame or
 * credit the agent; an explicit causal binding from an independent source is
 * required. A competing external cause is reported as CONFLICT instead of
 * being resolved by preference. A repair closes one named decision/artifact,
 * never a family: a later success in the same family is not repair evidence,
 * and the agent cannot verify its own repair. An unresolved error record and
 * its responsibility status are never erased here. Signal-only; nothing acts.
 */

const { createHash } = require('node:crypto');
const { COGNITION_STATUS, AUTHORITY, freezeResult } = require('./contract');
const { isPlainObject } = require('../is-plain-object');
const { stableStringify } = require('../hash-chain');

const SCHEMA_VERSION = 'huqan-cognition-attribution-v1';
const ATTRIBUTION = Object.freeze({
  AGENT_CAUSED: 'AGENT_CAUSED',
  EXTERNAL: 'EXTERNAL',
  CONFLICT: 'CONFLICT',
  UNKNOWN: 'UNKNOWN',
});
const EVIDENCE_KIND = Object.freeze({
  EXECUTION: 'execution',
  JOURNAL_OBSERVATION: 'journal-observation',
  INDEPENDENT_VERIFICATION: 'independent-verification',
  HOST_DECLARED: 'host-declared-binding',
  EXTERNAL_CAUSE: 'external-cause',
  SELF_REPORT: 'self-report',
});
const CAUSAL_KINDS = Object.freeze([
  EVIDENCE_KIND.JOURNAL_OBSERVATION, EVIDENCE_KIND.INDEPENDENT_VERIFICATION, EVIDENCE_KIND.HOST_DECLARED,
]);
const VERIFICATION_KINDS = Object.freeze([
  EVIDENCE_KIND.JOURNAL_OBSERVATION, EVIDENCE_KIND.INDEPENDENT_VERIFICATION,
]);
const OUTCOME_STATES = Object.freeze(['confirmed', 'contradiction']);

const text = (value) => typeof value === 'string' && value.trim() !== '';
const hasOnlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const timeOf = (value) => (typeof value === 'string' && ZONED_TIMESTAMP.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);

const reject = (reason) => freezeResult({
  schemaVersion: SCHEMA_VERSION, status: COGNITION_STATUS.REJECT, reason,
  attribution: ATTRIBUTION.UNKNOWN, sources: [], sourceDigest: null, authority: AUTHORITY.SIGNAL_ONLY,
});
const abstain = (reason) => freezeResult({
  schemaVersion: SCHEMA_VERSION, status: COGNITION_STATUS.ABSTAIN, reason,
  attribution: ATTRIBUTION.UNKNOWN, sources: [], sourceDigest: null, authority: AUTHORITY.SIGNAL_ONLY,
});

// Evidence is { kind, ref, workspaceId? }. The kind names its provenance; a
// reference without a known kind is unusable, not an empty string.
function readEvidence(raw, allowedKinds, workspaceId, extraKeys = []) {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ['kind', 'ref', 'workspaceId', ...extraKeys])) return { status: 'INVALID' };
  if (!allowedKinds.includes(raw.kind)) {
    return raw.kind === EVIDENCE_KIND.SELF_REPORT ? { status: 'SELF_REPORT' } : { status: 'INVALID' };
  }
  if (raw.workspaceId !== undefined && (!text(raw.workspaceId) || raw.workspaceId !== workspaceId)) {
    return { status: 'CROSS_WORKSPACE' };
  }
  if (!text(raw.ref)) return { status: 'INVALID' };
  return { status: 'KNOWN', kind: raw.kind, ref: raw.ref.trim() };
}

function checkTimes(input) {
  const at = timeOf(input.at);
  const asOf = timeOf(input.asOf);
  if (at === null || asOf === null) return { status: 'INVALID' };
  if (at > asOf) return { status: 'FUTURE' };
  return { status: 'OK', at: input.at };
}

function digestOf(scope, sources) {
  return createHash('sha256').update(stableStringify({ ...scope, sources })).digest('hex');
}

/**
 * Attribute an observed outcome to the agent or to an external cause.
 *
 * @param {unknown} input - { eventId, workspaceId, at, asOf,
 *   action: { decisionId, kind: 'execution', ref, workspaceId? },
 *   outcome: { decisionId, state: 'confirmed'|'contradiction', kind, ref, workspaceId? },
 *   causal?: { decisionId, kind, ref, workspaceId? },
 *   external?: { kind: 'external-cause', ref, workspaceId? } }
 */
function attributeOutcome(input) {
  if (!isPlainObject(input)) return reject('invalid_input');
  if (!hasOnlyKeys(input, ['eventId', 'workspaceId', 'at', 'asOf', 'action', 'outcome', 'causal', 'external'])) {
    return reject('invalid_input');
  }
  if (!text(input.eventId) || !text(input.workspaceId)) return reject('invalid_input');
  const times = checkTimes(input);
  if (times.status === 'INVALID') return reject('invalid_input');
  if (times.status === 'FUTURE') return reject('future_observation');

  if (!isPlainObject(input.action) || !hasOnlyKeys(input.action, ['decisionId', 'kind', 'ref', 'workspaceId'])) {
    return reject('invalid_input');
  }
  if (!text(input.action.decisionId)) return reject('invalid_input');
  const execution = readEvidence(input.action, [EVIDENCE_KIND.EXECUTION], input.workspaceId, ['decisionId']);
  if (execution.status === 'INVALID' || execution.status === 'SELF_REPORT') return reject('invalid_execution_evidence');
  if (execution.status === 'CROSS_WORKSPACE') return reject('cross_workspace_evidence');

  if (!isPlainObject(input.outcome)) return abstain('outcome_unknown');
  if (!text(input.outcome.decisionId) || !OUTCOME_STATES.includes(input.outcome.state)) return reject('invalid_outcome');
  if (input.outcome.decisionId !== input.action.decisionId) return abstain('outcome_binding_mismatch');
  const outcome = readEvidence(input.outcome, [EVIDENCE_KIND.JOURNAL_OBSERVATION, EVIDENCE_KIND.INDEPENDENT_VERIFICATION], input.workspaceId, ['decisionId', 'state']);
  if (outcome.status === 'INVALID' || outcome.status === 'SELF_REPORT') return reject('invalid_outcome_evidence');
  if (outcome.status === 'CROSS_WORKSPACE') return reject('cross_workspace_evidence');

  let causal = { status: 'ABSENT' };
  if (input.causal !== undefined) {
    if (!isPlainObject(input.causal) || !text(input.causal.decisionId)) return reject('invalid_causal_evidence');
    causal = readEvidence(input.causal, CAUSAL_KINDS, input.workspaceId, ['decisionId']);
    if (causal.status === 'SELF_REPORT') return abstain('self_report_is_not_evidence');
    if (causal.status === 'INVALID') return reject('invalid_causal_evidence');
    if (causal.status === 'CROSS_WORKSPACE') return reject('cross_workspace_evidence');
    if (input.causal.decisionId !== input.action.decisionId) return abstain('causal_binding_mismatch');
  }

  let external = { status: 'ABSENT' };
  if (input.external !== undefined) {
    external = readEvidence(input.external, [EVIDENCE_KIND.EXTERNAL_CAUSE], input.workspaceId);
    if (external.status === 'INVALID' || external.status === 'SELF_REPORT') return reject('invalid_external_evidence');
    if (external.status === 'CROSS_WORKSPACE') return reject('cross_workspace_evidence');
  }

  if (causal.status === 'KNOWN' && external.status === 'KNOWN') {
    return freezeResult({
      schemaVersion: SCHEMA_VERSION, eventId: input.eventId, status: COGNITION_STATUS.MEASURED,
      reason: 'competing_causes', attribution: ATTRIBUTION.CONFLICT,
      dimensions: {
        action: { decisionId: input.action.decisionId, kind: execution.kind, ref: execution.ref },
        outcome: { decisionId: input.outcome.decisionId, state: input.outcome.state, kind: outcome.kind, ref: outcome.ref },
        causal: { kind: causal.kind, ref: causal.ref }, external: { kind: external.kind, ref: external.ref },
      },
      sources: [{ dimension: 'action', ref: execution.ref }, { dimension: 'causal', ref: causal.ref },
        { dimension: 'external', ref: external.ref }, { dimension: 'outcome', ref: outcome.ref }],
      sourceDigest: digestOf({ eventId: input.eventId, workspaceId: input.workspaceId, at: input.at },
        [execution.ref, causal.ref, external.ref, outcome.ref]),
      authority: AUTHORITY.SIGNAL_ONLY,
    });
  }
  if (external.status === 'KNOWN') {
    return freezeResult({
      schemaVersion: SCHEMA_VERSION, eventId: input.eventId, status: COGNITION_STATUS.MEASURED,
      reason: 'external_cause_observed', attribution: ATTRIBUTION.EXTERNAL,
      dimensions: {
        action: { decisionId: input.action.decisionId, kind: execution.kind, ref: execution.ref },
        outcome: { decisionId: input.outcome.decisionId, state: input.outcome.state, kind: outcome.kind, ref: outcome.ref },
        external: { kind: external.kind, ref: external.ref },
      },
      sources: [{ dimension: 'action', ref: execution.ref }, { dimension: 'external', ref: external.ref },
        { dimension: 'outcome', ref: outcome.ref }],
      sourceDigest: digestOf({ eventId: input.eventId, workspaceId: input.workspaceId, at: input.at },
        [execution.ref, external.ref, outcome.ref]),
      authority: AUTHORITY.SIGNAL_ONLY,
    });
  }
  if (causal.status !== 'KNOWN') return abstain('execution_is_not_causation');

  return freezeResult({
    schemaVersion: SCHEMA_VERSION, eventId: input.eventId, status: COGNITION_STATUS.MEASURED,
    reason: 'independent_causal_binding', attribution: ATTRIBUTION.AGENT_CAUSED,
    dimensions: {
      action: { decisionId: input.action.decisionId, kind: execution.kind, ref: execution.ref },
      outcome: { decisionId: input.outcome.decisionId, state: input.outcome.state, kind: outcome.kind, ref: outcome.ref },
      causal: { kind: causal.kind, ref: causal.ref },
    },
    sources: [{ dimension: 'action', ref: execution.ref }, { dimension: 'causal', ref: causal.ref },
      { dimension: 'outcome', ref: outcome.ref }],
    sourceDigest: digestOf({ eventId: input.eventId, workspaceId: input.workspaceId, at: input.at },
      [execution.ref, causal.ref, outcome.ref]),
    authority: AUTHORITY.SIGNAL_ONLY,
  });
}

const repairWithheld = (reason, extra = {}) => freezeResult({
  schemaVersion: SCHEMA_VERSION, status: COGNITION_STATUS.ABSTAIN, reason,
  closure: 'WITHHELD', authority: AUTHORITY.SIGNAL_ONLY, ...extra,
});

/**
 * Decide whether one repair closes one named prior error.
 *
 * @param {unknown} input - { repairId, workspaceId, at, asOf,
 *   target: { decisionId?, artifactRef?, kind, ref, workspaceId? },
 *   executor: { actorRef }, verification: { verdict, verifierRef, kind, ref, workspaceId? } }
 * @param {unknown} context - { error: { decisionId, artifactRef?, family?, status,
 *   closedBy?: string[], workspaceId? }, laterSuccesses?: object[] }
 */
function evaluateRepair(input, context) {
  if (!isPlainObject(input) || !isPlainObject(context)) return reject('invalid_input');
  if (!hasOnlyKeys(input, ['repairId', 'workspaceId', 'at', 'asOf', 'target', 'executor', 'verification'])) {
    return reject('invalid_input');
  }
  if (!text(input.repairId) || !text(input.workspaceId)) return reject('invalid_input');
  const times = checkTimes(input);
  if (times.status === 'INVALID') return reject('invalid_input');
  if (times.status === 'FUTURE') return reject('future_observation');

  if (!isPlainObject(context.error) || !text(context.error.decisionId)) return reject('invalid_error');
  if (context.error.workspaceId !== undefined && context.error.workspaceId !== input.workspaceId) {
    return reject('cross_workspace_evidence');
  }
  if (!isPlainObject(input.target) || !hasOnlyKeys(input.target, ['decisionId', 'artifactRef', 'kind', 'ref', 'workspaceId'])) {
    return reject('invalid_input');
  }
  if (!text(input.target.decisionId) && !text(input.target.artifactRef)) return reject('invalid_target');
  const targetEvidence = readEvidence(input.target, VERIFICATION_KINDS, input.workspaceId, ['decisionId', 'artifactRef']);
  if (targetEvidence.status === 'INVALID' || targetEvidence.status === 'SELF_REPORT') return reject('invalid_target');
  if (targetEvidence.status === 'CROSS_WORKSPACE') return reject('cross_workspace_evidence');

  if (!isPlainObject(input.executor) || !text(input.executor.actorRef)) return reject('invalid_executor');
  if (!isPlainObject(input.verification) || !text(input.verification.verifierRef)) return reject('invalid_verification');
  if (input.verification.workspaceId !== undefined && input.verification.workspaceId !== input.workspaceId) {
    return reject('cross_workspace_evidence');
  }
  if (input.verification.verdict !== 'confirmed' && input.verification.verdict !== 'contradiction') {
    return reject('invalid_verification');
  }

  const verification = readEvidence(input.verification, VERIFICATION_KINDS, input.workspaceId, ['verdict', 'verifierRef']);
  if (verification.status === 'SELF_REPORT') return repairWithheld('self_verification');
  if (verification.status === 'INVALID') return reject('invalid_verification');
  if (verification.status === 'CROSS_WORKSPACE') return reject('cross_workspace_evidence');
  if (input.verification.verifierRef === input.executor.actorRef) return repairWithheld('self_verification');
  if (input.verification.verdict !== 'confirmed') return repairWithheld('repair_not_verified');

  const specific = (text(input.target.decisionId) && input.target.decisionId === context.error.decisionId)
    || (text(input.target.artifactRef) && text(context.error.artifactRef)
      && input.target.artifactRef === context.error.artifactRef);
  if (!specific) return repairWithheld('repair_target_not_specific');

  const closedBy = Array.isArray(context.error.closedBy) ? context.error.closedBy : [];
  if (context.error.status === 'closed' || closedBy.includes(input.repairId)) return repairWithheld('already_closed');

  const laterSuccesses = Array.isArray(context.laterSuccesses)
    ? context.laterSuccesses.filter((row) => isPlainObject(row) && row.family === context.error.family).length
    : 0;
  const sources = [{ dimension: 'target', ref: targetEvidence.ref }, { dimension: 'verification', ref: verification.ref }];
  return freezeResult({
    schemaVersion: SCHEMA_VERSION, repairId: input.repairId, status: COGNITION_STATUS.MEASURED,
    reason: 'specific_repair_verified', closure: 'CLOSED', errorStatusBefore: context.error.status,
    target: { decisionId: context.error.decisionId, artifactRef: context.error.artifactRef ?? null },
    laterSuccessesIgnoredAsRepair: laterSuccesses,
    sources, sourceDigest: digestOf({ repairId: input.repairId, workspaceId: input.workspaceId, at: input.at },
      [targetEvidence.ref, verification.ref]),
    authority: AUTHORITY.SIGNAL_ONLY,
  });
}

module.exports = {
  SCHEMA_VERSION, ATTRIBUTION, EVIDENCE_KIND, CAUSAL_KINDS, VERIFICATION_KINDS,
  attributeOutcome, evaluateRepair,
};
