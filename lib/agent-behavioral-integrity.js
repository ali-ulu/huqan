'use strict';

const crypto = require('node:crypto');
const {
  assessBehavior,
  createBehavioralBaseline,
} = require('./self-healer/behavioral-containment');

const MANIFEST_VERSION = 'huqan.agent-behavior.v1';
const DEFAULT_AGENT_ID = 'agent-v3';
const DEFAULT_CONNECTOR = 'internal';
const DEFAULT_TARGET_CLASS = 'internal';
const DEFAULT_EGRESS_CLASS = 'none';
const DEFAULT_DELEGATION_CLASS = 'none';
const DEFAULT_REPEATED_ANOMALY_THRESHOLD = 3;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function normalizeList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(text)
    .filter(Boolean))];
}

function boundedToken(value, fallback = '') {
  const normalized = text(value);
  return (normalized || fallback).slice(0, 80).toLowerCase();
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function buildBehavioralManifest({ goal, workspaceId, selectedTools, agentId } = {}) {
  const manifest = {
    version: MANIFEST_VERSION,
    goal: text(goal),
    workspaceId: text(workspaceId) || 'default',
    allowedTools: [...new Set(normalizeList(selectedTools))].sort(),
    ...(text(agentId) ? { agentId: text(agentId) } : {}),
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return Object.freeze({ ...manifest, hash });
}

function evaluateBehavioralStep({ manifest, state, step } = {}) {
  // Low-level test and compatibility callers may invoke `_executeStep` without
  // a run state. Production run() always materializes the manifest first.
  if (!manifest) return { allowed: true, code: null, containment: null };
  if (manifest.version !== MANIFEST_VERSION) {
    return { allowed: false, code: 'BEHAVIORAL_MANIFEST_INVALID', containment: 'quarantine' };
  }
  if (text(state?.workspaceId) !== manifest.workspaceId) {
    return { allowed: false, code: 'BEHAVIORAL_WORKSPACE_DRIFT', containment: 'quarantine' };
  }
  if (manifest.agentId && text(state?.agentId) !== manifest.agentId) {
    return { allowed: false, code: 'BEHAVIORAL_IDENTITY_DRIFT', containment: 'quarantine' };
  }
  const input = isObject(step?.input) ? step.input : {};
  const attemptedGoal = text(step?.goal) || text(input.goal);
  if (attemptedGoal && attemptedGoal !== manifest.goal) {
    return { allowed: false, code: 'BEHAVIORAL_GOAL_DRIFT', containment: 'quarantine' };
  }
  if (!manifest.allowedTools.includes(text(step?.tool))) {
    return { allowed: false, code: 'BEHAVIORAL_TOOL_DEVIATION', containment: 'block' };
  }
  return { allowed: true, code: null, containment: null };
}

function effectiveAgentId(state, requestedAgentId) {
  return text(requestedAgentId) || text(state?.agentId) || DEFAULT_AGENT_ID;
}

function initializeBehavioralState(state, {
  goal,
  workspaceId,
  selectedTools,
  agentId,
  capabilities,
  connectors,
  targetClasses,
  egressClasses,
  delegation,
} = {}) {
  const effectiveGoal = text(goal) || text(state?.goal);
  const effectiveWorkspaceId = text(workspaceId) || text(state?.workspaceId) || 'default';
  const effectiveTools = normalizeList(selectedTools || state?.selectedTools);
  const plannedCapabilities = isObject(state?.plan)
    ? normalizeList((Array.isArray(state.plan.steps) ? state.plan.steps : []).map(step => step?.action))
    : [];
  const effectiveCapabilities = capabilities || [...new Set([...effectiveTools, ...plannedCapabilities])];
  const derivedCapabilities = effectiveTools.includes('verify') && effectiveTools.includes('dream')
    ? ['dream-experiment-verify']
    : [];
  const baselineCapabilities = [...new Set([...effectiveCapabilities, ...effectiveTools, ...derivedCapabilities])];
  const effectiveAgentId = effectiveAgentIdForState(state, agentId);
  state.agentId = text(state?.agentId) || effectiveAgentId;
  state.behavioralManifest ||= buildBehavioralManifest({
    goal: effectiveGoal,
    workspaceId: effectiveWorkspaceId,
    selectedTools: effectiveTools,
    agentId: effectiveAgentId,
  });
  state.behavioralBaseline ||= createBehavioralBaseline({
    goal: effectiveGoal,
    workspaceId: effectiveWorkspaceId,
    agentId: effectiveAgentId,
    capabilities: baselineCapabilities,
    tools: effectiveTools,
    connectors: connectors || [DEFAULT_CONNECTOR],
    targetClasses: targetClasses || [DEFAULT_TARGET_CLASS],
    egressClasses: egressClasses || [DEFAULT_EGRESS_CLASS],
    delegation: delegation || [DEFAULT_DELEGATION_CLASS],
  });
  state.behavioralFindings = Array.isArray(state.behavioralFindings) ? state.behavioralFindings : [];
  state.behavioralAnomalyCounts = isObject(state.behavioralAnomalyCounts)
    ? state.behavioralAnomalyCounts
    : {};
  state.behavioralContainmentEvents = Array.isArray(state.behavioralContainmentEvents)
    ? state.behavioralContainmentEvents
    : [];
  return state.behavioralManifest;
}

function effectiveAgentIdForState(state, requestedAgentId) {
  return effectiveAgentId(state, requestedAgentId);
}

function inputValue(input, ...keys) {
  for (const key of keys) {
    if (input && input[key] !== undefined && input[key] !== null) {
      const value = text(input[key]);
      if (value) return value;
    }
  }
  return '';
}

function targetClassFor(input) {
  const explicit = inputValue(input, 'targetClass', 'target_class');
  if (explicit) return explicit;
  const target = inputValue(input, 'target', 'resource');
  return target ? 'external' : DEFAULT_TARGET_CLASS;
}

function buildBehavioralObservation(state, step, firewallDecision) {
  const input = isObject(step?.input) ? step.input : {};
  const metadata = isObject(firewallDecision?.metadata) ? firewallDecision.metadata : {};
  const priorTools = Array.isArray(state?.steps)
    ? state.steps.map(item => text(item?.tool)).filter(Boolean).slice(-63)
    : [];
  const tool = boundedToken(step?.tool);
  const action = boundedToken(step?.action || input.action || step?.tool);
  const connector = boundedToken(inputValue(input, 'connector', 'connectorId') || metadata.connector, DEFAULT_CONNECTOR);
  const targetClass = boundedToken(targetClassFor(input), DEFAULT_TARGET_CLASS);
  const egressClass = boundedToken(inputValue(input, 'egressClass', 'egress', 'egress_class'), DEFAULT_EGRESS_CLASS);
  const delegationClass = boundedToken(inputValue(input, 'delegationClass', 'delegation', 'delegation_class'), DEFAULT_DELEGATION_CLASS);
  return {
    workspaceId: text(state?.workspaceId) || 'default',
    agentId: effectiveAgentId(state),
    tool,
    action,
    connector,
    targetClass,
    egressClass,
    delegationClass,
    sequenceLength: priorTools.length + 1,
    sequenceTools: [...priorTools, tool].filter(Boolean),
  };
}

function anomalyKey(observation) {
  return [
    observation.workspaceId,
    observation.agentId,
    observation.tool,
    observation.action,
    observation.connector,
    observation.targetClass,
    observation.egressClass,
    observation.delegationClass,
  ].join('|').slice(0, 512);
}

function legacyResult(state, step, behavioral) {
  state.behavioralFindings ||= [];
  state.behavioralFindings.push({
    code: behavioral.code,
    containment: behavioral.containment,
    tool: text(step?.tool) || null,
    decision: behavioral.containment === 'block' ? 'block' : 'quarantine',
  });
  state.containment = behavioral.containment;
  return {
    ok: false,
    type: 'agent',
    data: null,
    evidence: [],
    error: { code: behavioral.code, message: 'Agent step deviates from its behavioral manifest.' },
    meta: {
      blocked: true,
      containment: behavioral.containment,
      behavioralManifestHash: state.behavioralManifest?.hash || null,
      behavioralBaselineHash: state.behavioralBaseline?.baselineHash || null,
    },
  };
}

function richResult(state, step, assessment, firewallDecision) {
  const containment = assessment.containment?.action || 'quarantine';
  const key = anomalyKey(assessment.observation);
  state.behavioralAnomalyCounts ||= {};
  state.behavioralAnomalyCounts[key] = Number(state.behavioralAnomalyCounts?.[key] || 0) + 1;
  state.behavioralFindings ||= [];
  state.behavioralFindings.push({
    code: assessment.deviationCode,
    containment,
    decision: assessment.decision,
    tool: assessment.observation.tool,
    receiptId: assessment.receiptSummary?.receiptId || null,
  });
  state.behavioralContainmentEvents ||= [];
  state.behavioralContainmentEvents.push({
    code: assessment.deviationCode,
    decision: assessment.decision,
    containment,
    receiptId: assessment.receiptSummary?.receiptId || null,
    baselineHash: assessment.receiptSummary?.baselineHash || null,
    scope: assessment.receiptSummary?.scope || null,
  });
  state.containment = containment;
  const approval = firewallDecision?.metadata?.approval || firewallDecision?.approval || null;
  return {
    ok: false,
    type: 'agent',
    data: null,
    evidence: assessment.finding ? [assessment.finding] : [],
    error: {
      code: `BEHAVIORAL_${String(assessment.deviationCode || 'DEVIATION').toUpperCase()}`,
      message: assessment.deviationCode === 'repeated_anomaly'
        ? 'Repeated behavioral anomaly requires operator review; execution is paused fail-closed.'
        : 'Agent step deviates from its scoped behavioral baseline.',
    },
    meta: {
      blocked: true,
      containment,
      behavioralDecision: assessment.decision,
      behavioralDeviationCode: assessment.deviationCode,
      behavioralManifestHash: state.behavioralManifest?.hash || null,
      behavioralBaselineHash: assessment.receiptSummary?.baselineHash || state.behavioralBaseline?.baselineHash || null,
      behavioralReceiptId: assessment.receiptSummary?.receiptId || null,
      behavioralSequence: assessment.sequenceSummary,
      firewallDecision: firewallDecision?.decision || null,
      approvalDecision: approval?.decision || null,
      executorSuppressed: assessment.containment?.executorSuppressed === true,
    },
  };
}

function behavioralBlockResult(state, step, { firewallDecision, repeatedAnomalyThreshold } = {}) {
  const manifestDecision = evaluateBehavioralStep({ manifest: state?.behavioralManifest, state, step });
  if (!state?.behavioralManifest) return null;
  if (!manifestDecision.allowed) return legacyResult(state, step, manifestDecision);
  const baseline = state?.behavioralBaseline;
  if (!baseline) {
    return richResult(state, step, assessBehavior({
      baseline: null,
      observation: buildBehavioralObservation(state, step, firewallDecision),
    }, { repeatedAnomalyThreshold }), firewallDecision);
  }
  const observation = buildBehavioralObservation(state, step, firewallDecision);
  const key = anomalyKey(observation);
  const repeatedAnomalies = Number(state.behavioralAnomalyCounts?.[key] || 0);
  const assessment = assessBehavior({
    baseline,
    observation: { ...observation, repeatedAnomalies },
  }, { repeatedAnomalyThreshold: repeatedAnomalyThreshold || DEFAULT_REPEATED_ANOMALY_THRESHOLD });
  if (!assessment.deviationCode) return null;
  return richResult(state, step, assessment, firewallDecision);
}

module.exports = {
  DEFAULT_AGENT_ID,
  MANIFEST_VERSION,
  buildBehavioralManifest,
  evaluateBehavioralStep,
  initializeBehavioralState,
  buildBehavioralObservation,
  behavioralBlockResult,
};
