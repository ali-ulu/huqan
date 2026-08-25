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

const crypto = require('node:crypto');
const { normalizeWorkspaceId } = require('../workspace-id');
const { createFinding } = require('./finding-schema');
const { isPlainObject } = require('../is-plain-object');

const BEHAVIORAL_CONTAINMENT_VERSION = 'asi10-behavioral-v0.1.0';
const MAX_LIST_ITEMS = 16;
const MAX_TOKEN_LENGTH = 80;
const MAX_SEQUENCE_LENGTH = 64;
const DEFAULT_REPEATED_ANOMALY_THRESHOLD = 3;

const BEHAVIORAL_DECISIONS = Object.freeze({
  OBSERVE: 'observe',
  REQUIRE_REVIEW: 'require_review',
  BLOCK: 'block',
  QUARANTINE: 'quarantine',
});

const BEHAVIORAL_DEVIATION_CODES = Object.freeze({
  BASELINE_MISSING: 'baseline_missing',
  OBSERVATION_INCOMPLETE: 'observation_incomplete',
  WORKSPACE_DRIFT: 'workspace_drift',
  IDENTITY_DRIFT: 'identity_drift',
  UNEXPECTED_TOOL: 'unexpected_tool',
  UNEXPECTED_ACTION: 'unexpected_action',
  UNEXPECTED_CONNECTOR: 'unexpected_connector',
  UNEXPECTED_TARGET: 'unexpected_target',
  UNEXPECTED_EGRESS: 'unexpected_egress',
  UNEXPECTED_DELEGATION: 'unexpected_delegation',
  REPEATED_ANOMALY: 'repeated_anomaly',
});

function normalizeString(value, fallback = '') {
  const normalized = String(value == null ? '' : value).trim();
  return normalized ? normalized.slice(0, MAX_TOKEN_LENGTH) : fallback;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => normalizeString(item).toLowerCase())
    .filter(Boolean))].slice(0, MAX_LIST_ITEMS);
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function hasArrayField(source, keys) {
  return keys.some((key) => hasOwn(source, key) && Array.isArray(source[key]));
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fingerprint(value) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  if (/^[a-f0-9]{16,128}$/i.test(normalized)) return normalized.toLowerCase();
  return stableHash({ value: normalized }).slice(0, 32);
}

function boundedInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(MAX_SEQUENCE_LENGTH, Math.floor(parsed)));
}

function freezeList(value) {
  return Object.freeze([...value]);
}

function createBehavioralBaseline(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const goalFingerprint = fingerprint(source.goalFingerprint || source.goal);
  const scope = {
    goalFingerprint,
    capabilities: normalizeList(source.capabilities),
    tools: normalizeList(source.tools ?? source.allowedTools),
    connectors: normalizeList(source.connectors ?? source.allowedConnectors),
    targetClasses: normalizeList(source.targetClasses ?? source.allowedTargetClasses),
    egressClasses: normalizeList(source.egressClasses ?? source.egress),
    delegation: normalizeList(source.delegation ?? source.allowedDelegation),
  };
  const declared = [
    Boolean(goalFingerprint),
    hasArrayField(source, ['capabilities']),
    hasArrayField(source, ['tools', 'allowedTools']),
    hasArrayField(source, ['connectors', 'allowedConnectors']),
    hasArrayField(source, ['targetClasses', 'allowedTargetClasses']),
    hasArrayField(source, ['egressClasses', 'egress']),
    hasArrayField(source, ['delegation', 'allowedDelegation']),
  ];
  const workspaceId = normalizeWorkspaceId(source.workspaceId);
  const agentId = normalizeString(source.agentId);
  const canonical = {
    version: BEHAVIORAL_CONTAINMENT_VERSION,
    workspaceId,
    agentId,
    scope,
  };
  const baselineHash = stableHash(canonical).slice(0, 32);
  return Object.freeze({
    ...canonical,
    scope: Object.freeze({
      ...scope,
      capabilities: freezeList(scope.capabilities),
      tools: freezeList(scope.tools),
      connectors: freezeList(scope.connectors),
      targetClasses: freezeList(scope.targetClasses),
      egressClasses: freezeList(scope.egressClasses),
      delegation: freezeList(scope.delegation),
    }),
    baselineHash,
    complete: Boolean(agentId) && declared.every(Boolean),
  });
}

function normalizeObservation(input = {}) {
  const source = isPlainObject(input) ? input : {};
  return {
    workspaceId: normalizeWorkspaceId(source.workspaceId),
    agentId: normalizeString(source.agentId),
    goalFingerprint: fingerprint(source.goalFingerprint || source.goal),
    tool: normalizeString(source.tool).toLowerCase(),
    action: normalizeString(source.action).toLowerCase(),
    connector: normalizeString(source.connector).toLowerCase(),
    targetClass: normalizeString(source.targetClass).toLowerCase(),
    egressClass: normalizeString(source.egressClass).toLowerCase(),
    delegationClass: normalizeString(source.delegationClass).toLowerCase(),
    sequenceLength: boundedInteger(source.sequenceLength),
    sequenceTools: normalizeList(source.sequenceTools),
    repeatedAnomalies: boundedInteger(source.repeatedAnomalies),
  };
}

function sequenceSummary(observation) {
  return Object.freeze({
    length: observation.sequenceLength,
    uniqueTools: freezeList(observation.sequenceTools),
    lastTool: observation.tool || null,
    lastAction: observation.action || null,
  });
}

function decisionFor(code) {
  return code === BEHAVIORAL_DEVIATION_CODES.REPEATED_ANOMALY
    ? BEHAVIORAL_DECISIONS.REQUIRE_REVIEW
    : code
      ? BEHAVIORAL_DECISIONS.QUARANTINE
      : BEHAVIORAL_DECISIONS.OBSERVE;
}

function containmentFor(decision, observation, baseline) {
  const action = decision === BEHAVIORAL_DECISIONS.REQUIRE_REVIEW
    ? 'pause'
    : decision === BEHAVIORAL_DECISIONS.OBSERVE
      ? 'none'
      : decision;
  const suppressed = action !== 'none';
  return Object.freeze({
    action,
    applied: false,
    executorSuppressed: suppressed,
    scope: Object.freeze({
      workspaceId: observation.workspaceId,
      agentId: observation.agentId || baseline.agentId || null,
    }),
    baselineScope: Object.freeze({
      workspaceId: baseline.workspaceId,
      agentId: baseline.agentId || null,
    }),
    reintegration: suppressed
      ? Object.freeze({
          required: true,
          operatorApprovalRequired: true,
          outcome: null,
          prerequisites: Object.freeze([
            'fresh_identity_verification',
            'fresh_dependency_verification',
            'fresh_policy_verification',
            'operator_approval',
          ]),
        })
      : Object.freeze({ required: false, operatorApprovalRequired: false, outcome: null, prerequisites: Object.freeze([]) }),
  });
}

function buildReceiptSummary({ baseline, observation, decision, deviationCode, sequence }) {
  const payload = {
    version: BEHAVIORAL_CONTAINMENT_VERSION,
    baselineHash: baseline.baselineHash || null,
    baselineVersion: baseline.version || null,
    decision,
    deviationCode: deviationCode || null,
    scope: {
      workspaceId: observation.workspaceId,
      agentId: observation.agentId || baseline.agentId || null,
    },
    sequence,
    operatorOutcome: null,
  };
  return Object.freeze({
    receiptId: `asi10_${stableHash(payload).slice(0, 16)}`,
    receiptKind: 'asi10_behavioral_containment_summary',
    version: BEHAVIORAL_CONTAINMENT_VERSION,
    baselineHash: payload.baselineHash,
    baselineVersion: payload.baselineVersion,
    decision,
    deviationCode: payload.deviationCode,
    scope: Object.freeze({ ...payload.scope }),
    sequenceSummary: sequence,
    operatorOutcome: null,
  });
}

function buildBehavioralFinding({ baseline, observation, decision, deviationCode, receipt, sequence }) {
  if (!deviationCode) return null;
  const severity = decision === BEHAVIORAL_DECISIONS.QUARANTINE || decision === BEHAVIORAL_DECISIONS.BLOCK
    ? 'high'
    : 'medium';
  return createFinding({
    kind: 'security',
    severity,
    confidence: 0.86,
    title: 'Behavioral integrity deviation detected',
    summary: `${deviationCode} detected against the declared agent/workspace baseline.`,
    evidence: [{
      type: 'manual',
      ref: `asi10:${deviationCode}`,
      detail: `baseline=${String(baseline.baselineHash || 'missing').slice(0, 16)}; sequenceLength=${sequence.length}`,
    }],
    affectedFiles: [],
    suggestedTests: ['Fresh identity, dependency, and policy verification before reintegration'],
    suggestedFix: {
      summary: 'Keep the scoped executor suppressed pending operator review and fresh verification.',
      allowedFiles: [],
      forbiddenFiles: [],
      risk: severity,
    },
    riskFlags: [
      'behavioral_deviation',
      ...(decision === BEHAVIORAL_DECISIONS.QUARANTINE ? ['behavioral_quarantine'] : []),
      deviationCode,
    ],
    status: 'candidate',
    receiptId: receipt.receiptId,
    workspaceId: observation.workspaceId,
  }, { workspaceId: observation.workspaceId });
}

function detectDeviation(observation, baseline, repeatedAnomalyThreshold) {
  if (!baseline || baseline.complete !== true) return BEHAVIORAL_DEVIATION_CODES.BASELINE_MISSING;
  if (!observation.agentId || !observation.tool || !observation.action) {
    return BEHAVIORAL_DEVIATION_CODES.OBSERVATION_INCOMPLETE;
  }
  if (observation.workspaceId !== baseline.workspaceId) return BEHAVIORAL_DEVIATION_CODES.WORKSPACE_DRIFT;
  if (observation.agentId !== baseline.agentId) return BEHAVIORAL_DEVIATION_CODES.IDENTITY_DRIFT;
  if (observation.goalFingerprint && observation.goalFingerprint !== baseline.scope.goalFingerprint) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_ACTION;
  if (!baseline.scope.tools.includes(observation.tool)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_TOOL;
  if (!baseline.scope.capabilities.includes(observation.action)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_ACTION;
  if (observation.connector && !baseline.scope.connectors.includes(observation.connector)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_CONNECTOR;
  if (observation.targetClass && !baseline.scope.targetClasses.includes(observation.targetClass)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_TARGET;
  if (observation.egressClass && !baseline.scope.egressClasses.includes(observation.egressClass)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_EGRESS;
  if (observation.delegationClass && !baseline.scope.delegation.includes(observation.delegationClass)) return BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_DELEGATION;
  if (observation.repeatedAnomalies >= repeatedAnomalyThreshold) return BEHAVIORAL_DEVIATION_CODES.REPEATED_ANOMALY;
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
      goalFingerprint: observation.goalFingerprint || null,
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
