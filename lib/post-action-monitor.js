'use strict';

const { createBehavioralBaseline, assessBehavior } = require('./self-healer/behavioral-containment');
const { classifyRawFinding } = require('./self-healer/finding-classifier');

const POST_ACTION_MONITOR_VERSION = 'huqan.post-action-monitor.v1';
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_SIDE_EFFECTS = 10_000;

const POST_ACTION_REASONS = Object.freeze({
  // "observed" names when the reading was taken, not who took it. Every value
  // behind it -- durationMs, sideEffectCount, behavioralObservation -- arrives
  // on `outcome`, supplied by the caller, so this is a reported observation and
  // not one HUQAN made. The receipt states which through
  // `metadata.effectVerification` (lib/external-action-receipt.js). The string
  // is kept as it is because it is already persisted in receipts on disk.
  OBSERVED: 'post_action_behavior_observed',
  ACTIVATION_REQUIRED: 'post_action_monitoring_requires_human_activation',
  ANOMALY_QUARANTINED: 'post_action_anomaly_quarantined',
});

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nowIso(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date().toISOString();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('post-action monitoring requires a valid clock');
  return parsed.toISOString();
}

function boundedNumber(value, maximum) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(maximum, Math.round(value));
}

function normalizeHumanActivation(input, evaluatedAt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const approvalId = text(input.approvalId);
  const actor = text(input.actor);
  const actorType = text(input.actorType).toLowerCase();
  const approvedAt = text(input.approvedAt);
  if (input.status !== 'approved' || !approvalId || !actor || actorType !== 'human' || !timestamp(approvedAt)) return null;
  if (timestamp(approvedAt) > timestamp(evaluatedAt)) return null;
  return Object.freeze({ approvalId, actor, actorType: 'human', approvedAt });
}

function targetClassFor(envelope) {
  if (envelope.target?.url) return 'network_endpoint';
  if (envelope.target?.path) return 'workspace_path';
  return 'external_action';
}

function normalizeBaseline(input, envelope, identity) {
  if (input?.complete === true && input?.scope && input?.version) return input;
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return createBehavioralBaseline({
    ...source,
    workspaceId: envelope.workspaceId,
    agentId: identity.agentId,
  });
}

function buildObservation(envelope, identity, outcome = {}, options = {}) {
  const supplied = outcome.behavioralObservation && typeof outcome.behavioralObservation === 'object'
    ? outcome.behavioralObservation
    : {};
  return {
    workspaceId: envelope.workspaceId,
    agentId: identity.agentId,
    tool: text(supplied.tool) || envelope.tool.name,
    action: text(supplied.action) || envelope.action,
    connector: text(supplied.connector) || text(envelope.metadata?.connector) || 'local',
    targetClass: text(supplied.targetClass) || targetClassFor(envelope),
    egressClass: text(supplied.egressClass) || text(envelope.metadata?.egressClass) || 'none',
    delegationClass: text(supplied.delegationClass) || text(envelope.metadata?.delegationClass) || 'none',
    sequenceLength: boundedNumber(supplied.sequenceLength, 1_000),
    sequenceTools: Array.isArray(supplied.sequenceTools) ? supplied.sequenceTools : [envelope.tool.name],
    repeatedAnomalies: boundedNumber(options.repeatedAnomalies, 1_000),
  };
}

function explicitAnomalyCode(outcome = {}) {
  if (outcome.policyViolation === true) return 'post_action_policy_violation';
  if (outcome.unexpectedSideEffect === true) return 'post_action_unexpected_side_effect';
  if (outcome.anomaly === true) return text(outcome.anomalyCode) || 'post_action_anomaly';
  return null;
}

function explicitFinding(code, envelope, receiptId) {
  return classifyRawFinding({
    kind: 'security',
    severity: 'high',
    confidence: 0.95,
    title: 'Post-action behavioral anomaly detected',
    summary: `${code} was reported after external action execution.`,
    evidence: [{ type: 'manual', ref: `post-action:${code}`, detail: `tool=${envelope.tool.name}` }],
    affectedFiles: [],
    suggestedTests: ['Fresh identity, dependency, and policy verification before release'],
    suggestedFix: {
      summary: 'Keep the identity quarantined pending operator review.',
      allowedFiles: [],
      forbiddenFiles: [],
      risk: 'high',
    },
    riskFlags: ['behavioral_deviation', 'behavioral_quarantine', code],
    status: 'candidate',
    receiptId,
    workspaceId: envelope.workspaceId,
  }, { workspaceId: envelope.workspaceId });
}

function findingSummary(finding) {
  if (!finding) return null;
  return Object.freeze({
    id: text(finding.id),
    kind: text(finding.kind),
    severity: text(finding.severity),
    status: text(finding.status),
    receiptId: text(finding.receiptId),
    riskFlags: Object.freeze((Array.isArray(finding.riskFlags) ? finding.riskFlags : []).map(String).slice(0, 16)),
  });
}

function evaluatePostActionBehavior(input = {}, options = {}) {
  const envelope = input.envelope;
  const identity = input.identity;
  if (!envelope || !identity?.agentId) throw new TypeError('post-action monitoring requires an envelope and identity');
  const observedAt = nowIso(options);
  const activation = normalizeHumanActivation(options.activation, observedAt);
  const outcome = input.outcome && typeof input.outcome === 'object' ? input.outcome : {};
  const signal = Object.freeze({
    outcomeStatus: outcome.status === 'success' ? 'executed' : outcome.status === 'blocked' ? 'blocked' : 'failed',
    durationMs: boundedNumber(outcome.durationMs, MAX_DURATION_MS),
    sideEffectCount: boundedNumber(outcome.sideEffectCount, MAX_SIDE_EFFECTS),
    policyViolation: outcome.policyViolation === true,
    unexpectedSideEffect: outcome.unexpectedSideEffect === true,
  });

  if (!activation) {
    const receiptSummary = Object.freeze({
      schemaVersion: POST_ACTION_MONITOR_VERSION,
      active: false,
      activationRequired: true,
      activation: null,
      observedAt,
      signal,
      anomaly: false,
      anomalyCode: null,
      decision: 'activation_required',
      reason: POST_ACTION_REASONS.ACTIVATION_REQUIRED,
      quarantine: Object.freeze({ applied: false, demotedTo: null, humanReleaseRequired: true }),
      finding: null,
    });
    return Object.freeze({ ok: false, active: false, anomaly: false, quarantined: false, finding: null, receiptSummary });
  }

  const baseline = normalizeBaseline(options.baseline, envelope, identity);
  const assessment = assessBehavior({
    baseline,
    observation: buildObservation(envelope, identity, outcome, options),
  }, { repeatedAnomalyThreshold: options.repeatedAnomalyThreshold });
  const explicitCode = explicitAnomalyCode(outcome);
  const anomalyCode = explicitCode || assessment.deviationCode;
  const anomaly = Boolean(anomalyCode);
  const finding = anomaly
    ? classifyRawFinding(assessment.finding || explicitFinding(explicitCode, envelope, assessment.receiptSummary.receiptId), {
        workspaceId: envelope.workspaceId,
      })
    : null;
  const receiptSummary = Object.freeze({
    schemaVersion: POST_ACTION_MONITOR_VERSION,
    active: true,
    activationRequired: false,
    activation,
    observedAt,
    signal,
    baselineHash: assessment.receiptSummary.baselineHash || null,
    behavioralReceiptId: assessment.receiptSummary.receiptId,
    anomaly,
    anomalyCode: anomalyCode || null,
    decision: anomaly ? 'quarantine' : 'observe',
    reason: anomaly ? POST_ACTION_REASONS.ANOMALY_QUARANTINED : POST_ACTION_REASONS.OBSERVED,
    quarantine: Object.freeze({
      applied: anomaly,
      demotedTo: anomaly ? 'T1' : null,
      humanReleaseRequired: anomaly,
    }),
    finding: findingSummary(finding),
  });
  return Object.freeze({
    ok: true,
    active: true,
    anomaly,
    quarantined: anomaly,
    finding,
    assessment,
    receiptSummary,
  });
}

function postActionMonitoringOptions(options = {}) {
  const config = options.continuousMonitoring;
  const environment = options.environment || process.env;
  const envEnabled = /^(?:1|true|yes|on)$/i.test(text(environment.HUQAN_EXTERNAL_GUARD_CONTINUOUS_MONITORING));
  if (config !== true && !config?.enabled && !envEnabled) return null;
  const source = config && typeof config === 'object' ? config : {};
  return {
    activation: source.activation || null,
    baseline: source.baseline || null,
    receipts: Array.isArray(source.receipts) ? source.receipts : undefined,
    receiptPath: text(source.receiptPath) || undefined,
    repeatedAnomalies: source.repeatedAnomalies,
    repeatedAnomalyThreshold: source.repeatedAnomalyThreshold,
    findingSink: typeof source.findingSink === 'function' ? source.findingSink : null,
    now: options.now,
  };
}

module.exports = {
  MAX_DURATION_MS,
  MAX_SIDE_EFFECTS,
  POST_ACTION_MONITOR_VERSION,
  POST_ACTION_REASONS,
  evaluatePostActionBehavior,
  normalizePostActionHumanActivation: normalizeHumanActivation,
  postActionMonitoringOptions,
};
