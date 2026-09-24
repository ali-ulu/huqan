'use strict';

/**
 * ASI10 — bounded behavioral integrity and containment.
 *
 * This module compares a caller-supplied, immutable-shaped run baseline with a
 * bounded observation. It emits deterministic deviation codes and an
 * agent/workspace-scoped containment recommendation. It never executes a
 * kill-switch, revokes credentials, applies a patch, or reintegrates an agent.
 * Those effects remain operator-controlled and require fresh verification.
 *
 * The output deliberately contains hashes, enum-like scope labels, and a
 * bounded sequence summary only. Raw goals, targets, payloads, credentials,
 * and provider material are not copied into findings or receipt summaries.
 */

// Split (#2217): baseline and observation normalization live in
// behavioral-containment-baseline.js, decisions and emitted records in
// behavioral-containment-records.js; this file detects and assesses.

const { isPlainObject } = require('../is-plain-object');
const { BEHAVIORAL_CONTAINMENT_VERSION, BEHAVIORAL_DECISIONS, BEHAVIORAL_DEVIATION_CODES, DEFAULT_REPEATED_ANOMALY_THRESHOLD, MAX_SEQUENCE_LENGTH, createBehavioralBaseline, normalizeObservation, sequenceSummary } = require('./behavioral-containment-baseline');
const { buildBehavioralFinding, buildReceiptSummary, containmentFor, decisionFor } = require('./behavioral-containment-records');

function detectDeviation(observation, baseline, repeatedAnomalyThreshold) {
  if (!baseline || baseline.complete !== true) return BEHAVIORAL_DEVIATION_CODES.BASELINE_MISSING;
  if (!observation.agentId || !observation.tool || !observation.action) {
    return BEHAVIORAL_DEVIATION_CODES.OBSERVATION_INCOMPLETE;
  }
  // Once the same bounded anomaly has been observed repeatedly, the decision
  // must change from quarantine to operator review/pause. This check precedes
  // the individual drift labels so a production caller can actually reach the
  // repeated-anomaly containment path instead of reporting the first label
  // forever.
  if (observation.repeatedAnomalies >= repeatedAnomalyThreshold) return BEHAVIORAL_DEVIATION_CODES.REPEATED_ANOMALY;
  if (observation.workspaceId !== baseline.workspaceId) return BEHAVIORAL_DEVIATION_CODES.WORKSPACE_DRIFT;
  if (observation.agentId !== baseline.agentId) return BEHAVIORAL_DEVIATION_CODES.IDENTITY_DRIFT;
  if (!baseline.scope.tools.includes(observation.tool)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_TOOL;
  if (!baseline.scope.capabilities.includes(observation.action)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_ACTION;
  if (observation.connector && !baseline.scope.connectors.includes(observation.connector)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_CONNECTOR;
  if (observation.targetClass && !baseline.scope.targetClasses.includes(observation.targetClass)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_TARGET;
  if (observation.egressClass && !baseline.scope.egressClasses.includes(observation.egressClass)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_EGRESS;
  if (observation.delegationClass && !baseline.scope.delegation.includes(observation.delegationClass)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_DELEGATION;
  return null;
}

/**
 * Compare one bounded observation against a declared baseline.
 *
 * `ok: false` is reserved for a missing/incomplete baseline, so a caller cannot
 * mistake an unbaselined observation for a successful behavioral check.
 */
function assessBehavior(input = {}, opts = {}) {
  const source = isPlainObject(input) ? input : {};
  const observation = normalizeObservation(source.observation || source);
  const baseline = source.baseline && isPlainObject(source.baseline)
    ? source.baseline
    : null;
  const threshold = Number.isInteger(opts.repeatedAnomalyThreshold) && opts.repeatedAnomalyThreshold > 0
    ? Math.min(MAX_SEQUENCE_LENGTH, opts.repeatedAnomalyThreshold)
    : DEFAULT_REPEATED_ANOMALY_THRESHOLD;
  const deviationCode = detectDeviation(observation, baseline, threshold);
  const decision = decisionFor(deviationCode);
  const sequence = sequenceSummary(observation);
  const safeBaseline = baseline || {
    version: null,
    baselineHash: null,
    workspaceId: observation.workspaceId,
    agentId: observation.agentId || null,
  };
  const containment = containmentFor(decision, observation, safeBaseline);
  const receiptSummary = buildReceiptSummary({
    baseline: safeBaseline,
    observation,
    decision,
    deviationCode,
    sequence,
  });
  const finding = buildBehavioralFinding({
    baseline: safeBaseline,
    observation,
    decision,
    deviationCode,
    receipt: receiptSummary,
    sequence,
  });
  return Object.freeze({
    ok: deviationCode !== BEHAVIORAL_DEVIATION_CODES.BASELINE_MISSING,
    version: BEHAVIORAL_CONTAINMENT_VERSION,
    status: decision === BEHAVIORAL_DECISIONS.OBSERVE ? 'observed' : 'contained_pending_review',
    decision,
    deviationCode,
    baseline: Object.freeze({
      version: safeBaseline.version,
      baselineHash: safeBaseline.baselineHash,
      complete: safeBaseline.complete === true,
      scope: safeBaseline.scope
        ? Object.freeze({
            workspaceId: safeBaseline.workspaceId,
            agentId: safeBaseline.agentId || null,
            goalFingerprint: safeBaseline.scope.goalFingerprint,
            capabilityCount: safeBaseline.scope.capabilities.length,
            toolCount: safeBaseline.scope.tools.length,
            connectorCount: safeBaseline.scope.connectors.length,
            targetClassCount: safeBaseline.scope.targetClasses.length,
            egressClassCount: safeBaseline.scope.egressClasses.length,
            delegationCount: safeBaseline.scope.delegation.length,
          })
        : null,
    }),
    observation: Object.freeze({
      workspaceId: observation.workspaceId,
      agentId: observation.agentId || null,
      tool: observation.tool || null,
      action: observation.action || null,
      connector: observation.connector || null,
      targetClass: observation.targetClass || null,
      egressClass: observation.egressClass || null,
      delegationClass: observation.delegationClass || null,
    }),
    sequenceSummary: sequence,
    containment,
    finding,
    receiptSummary,
    applied: false,
  });
}

module.exports = {
  BEHAVIORAL_CONTAINMENT_VERSION,
  BEHAVIORAL_DECISIONS,
  BEHAVIORAL_DEVIATION_CODES,
  DEFAULT_REPEATED_ANOMALY_THRESHOLD,
  assessBehavior,
  createBehavioralBaseline,
};
