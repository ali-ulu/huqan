'use strict';

const {
  BEHAVIORAL_CONTAINMENT_VERSION,
  assessBehavior,
  createBehavioralBaseline,
} = require('./self-healer/behavioral-containment');
const { createBehavioralContainmentRuntime } = require('./self-healer/behavioral-containment-runtime');

const MANIFEST_VERSION = BEHAVIORAL_CONTAINMENT_VERSION;
const MAX_TELEMETRY_EVENTS = 64;
const MAX_UNIQUE_TOOLS = 16;
const runtimeByState = new WeakMap();

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function list(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.map(text).filter(Boolean))].slice(0, MAX_UNIQUE_TOOLS);
}

function stepAction(step = {}) {
  return text(step.action || step.tool).toLowerCase();
}

function buildBehavioralManifest({ goal, workspaceId, selectedTools, agentId = 'agent', capabilities, connectors, targetClasses, egressClasses, delegation } = {}) {
  return createBehavioralBaseline({
    goal,
    workspaceId,
    agentId: text(agentId) || 'agent',
    capabilities: list(capabilities, list(selectedTools)),
    tools: list(selectedTools),
    connectors: list(connectors, ['kernel']),
    targetClasses: list(targetClasses, ['workspace']),
    egressClasses: list(egressClasses, ['none']),
    delegation: list(delegation, ['none']),
  });
}

function observationFor(state, step, telemetry) {
  const previousTools = Array.isArray(telemetry?.sequenceTools) ? telemetry.sequenceTools : [];
  return {
    workspaceId: state?.workspaceId,
    agentId: state?.agentId,
    goal: step?.goal || state?.goal,
    tool: text(step?.tool).toLowerCase(),
    action: stepAction(step),
    connector: text(step?.connector || 'kernel').toLowerCase(),
    targetClass: text(step?.targetClass || 'workspace').toLowerCase(),
    egressClass: text(step?.egressClass || 'none').toLowerCase(),
    delegationClass: text(step?.delegationClass || 'none').toLowerCase(),
    sequenceLength: Number(telemetry?.sequenceLength || 0) + 1,
    sequenceTools: [...previousTools, text(step?.tool).toLowerCase()].filter(Boolean).slice(-MAX_UNIQUE_TOOLS),
    repeatedAnomalies: Number(telemetry?.repeatedAnomalies || 0),
  };
}

function telemetryBase(manifest, state) {
  return {
    version: MANIFEST_VERSION,
    baselineVersion: manifest?.version || null,
    baselineHash: manifest?.baselineHash || manifest?.hash || null,
    scope: {
      workspaceId: text(state?.workspaceId) || manifest?.workspaceId || 'default',
      agentId: text(state?.agentId) || manifest?.agentId || null,
    },
    sequenceLength: 0,
    sequenceTools: [],
    eventCount: 0,
    deviationCount: 0,
    lastDeviationCode: null,
    lastContainment: 'none',
    events: [],
  };
}

function normalizeTelemetryEvent(event = {}) {
  return {
    sequence: Number(event.sequence || 0),
    tool: text(event.tool) || null,
    action: text(event.action).toLowerCase() || null,
    decision: text(event.decision).toLowerCase() || 'observe',
    deviationCode: text(event.deviationCode).toLowerCase() || null,
    containment: text(event.containment).toLowerCase() || 'none',
    receiptId: text(event.receiptId) || null,
  };
}

function telemetryFromNotes(manifest, state) {
  const notes = Array.isArray(state?.notes) ? state.notes : [];
  const events = notes
    .filter(note => note && note.behavioralEvent && typeof note.behavioralEvent === 'object')
    .map(note => normalizeTelemetryEvent(note.behavioralEvent))
    .slice(-MAX_TELEMETRY_EVENTS);
  if (events.length === 0) return telemetryBase(manifest, state);
  const latest = events[events.length - 1];
  return {
    ...telemetryBase(manifest, state),
    sequenceLength: latest.sequence,
    sequenceTools: [...new Set(events.map(event => event.tool).filter(Boolean))].slice(-MAX_UNIQUE_TOOLS),
    eventCount: events.length,
    deviationCount: events.filter(event => event.deviationCode).length,
    lastDeviationCode: latest.deviationCode,
    lastContainment: latest.containment,
    events,
  };
}

function runtimeFor(state) {
  if (!state || typeof state !== 'object') return null;
  let runtime = runtimeByState.get(state);
  if (!runtime) {
    runtime = createBehavioralContainmentRuntime();
    runtimeByState.set(state, runtime);
  }
  return runtime;
}

function appendTelemetry(state, assessment, observation) {
  const current = state.behavioralTelemetry || telemetryBase(state.behavioralManifest, state);
  const event = normalizeTelemetryEvent({
    sequence: Number(observation.sequenceLength || 0),
    tool: assessment.observation?.tool,
    action: assessment.observation?.action,
    decision: assessment.decision,
    deviationCode: assessment.deviationCode,
    containment: assessment.containment?.action,
    receiptId: assessment.receiptSummary?.receiptId,
  });
  const next = {
    ...current,
    version: MANIFEST_VERSION,
    baselineVersion: assessment.baseline?.version || current.baselineVersion || null,
    baselineHash: assessment.baseline?.baselineHash || current.baselineHash || null,
    scope: {
      workspaceId: assessment.containment?.scope?.workspaceId || current.scope.workspaceId,
      agentId: assessment.containment?.scope?.agentId || current.scope.agentId,
    },
    sequenceLength: observation.sequenceLength,
    sequenceTools: [...new Set([...(current.sequenceTools || []), ...(assessment.sequenceSummary?.uniqueTools || [])])].slice(-MAX_UNIQUE_TOOLS),
    eventCount: Number(current.eventCount || 0) + 1,
    deviationCount: Number(current.deviationCount || 0) + (assessment.deviationCode ? 1 : 0),
    lastDeviationCode: assessment.deviationCode || current.lastDeviationCode || null,
    lastContainment: assessment.containment?.action || 'none',
    events: [...(current.events || []), event].slice(-MAX_TELEMETRY_EVENTS),
  };
  state.behavioralTelemetry = next;
  state.notes ||= [];
  state.notes.push({ behavioralEvent: event });
  return next;
}

function containmentNote(state, contained) {
  state.notes ||= [];
  state.notes.push({
    behavioralContainment: {
      action: contained.action,
      reason: contained.reason,
      baselineHash: contained.baselineHash,
      deviationCode: contained.deviationCode,
      scope: contained.scope,
    },
  });
}

function blockedResult({ state, code, containment, assessment = null, runtimeState = null } = {}) {
  const normalizedCode = String(code || 'DEVIATION').toUpperCase();
  const errorCode = normalizedCode.startsWith('BEHAVIORAL_') ? normalizedCode : `BEHAVIORAL_${normalizedCode}`;
  state.behavioralFindings ||= [];
  if (assessment?.deviationCode) {
    state.behavioralFindings.push({
      code: assessment.deviationCode,
      containment: assessment.containment?.action || containment,
      tool: assessment.observation?.tool || null,
      action: assessment.observation?.action || null,
      receiptId: assessment.receiptSummary?.receiptId || null,
    });
  }
  state.containment = containment;
  return {
    ok: false,
    type: 'agent',
    data: null,
    evidence: assessment?.finding ? [assessment.finding] : [],
    error: {
      code: errorCode,
      message: runtimeState
        ? 'Agent execution is suppressed by scoped behavioral containment.'
        : 'Agent step deviates from its behavioral manifest.',
    },
    meta: {
      blocked: true,
      containment,
      behavioralManifestHash: state.behavioralManifest?.baselineHash || state.behavioralManifest?.hash || null,
      behavioralTelemetry: state.behavioralTelemetry,
      behavioralContainment: runtimeState,
      receiptSummary: assessment?.receiptSummary || null,
    },
  };
}

function legacyCodeFor(assessment, observation, step) {
  if (!assessment?.deviationCode) return null;
  const observedGoalFingerprint = assessment.observation?.goalFingerprint || observation.goalFingerprint;
  if (observedGoalFingerprint && observedGoalFingerprint !== assessment.baseline?.scope?.goalFingerprint) return 'BEHAVIORAL_GOAL_DRIFT';
  const names = {
    baseline_missing: 'BEHAVIORAL_MANIFEST_INVALID',
    observation_incomplete: 'BEHAVIORAL_OBSERVATION_INCOMPLETE',
    workspace_drift: 'BEHAVIORAL_WORKSPACE_DRIFT',
    identity_drift: 'BEHAVIORAL_IDENTITY_DRIFT',
    unexpected_tool: 'BEHAVIORAL_TOOL_DEVIATION',
    unexpected_action: 'BEHAVIORAL_ACTION_DEVIATION',
    unexpected_connector: 'BEHAVIORAL_CONNECTOR_DEVIATION',
    unexpected_target: 'BEHAVIORAL_TARGET_DEVIATION',
    unexpected_egress: 'BEHAVIORAL_EGRESS_DEVIATION',
    unexpected_delegation: 'BEHAVIORAL_DELEGATION_DEVIATION',
    repeated_anomaly: 'BEHAVIORAL_REPEATED_ANOMALY',
  };
  return names[assessment.deviationCode] || `BEHAVIORAL_${String(assessment.deviationCode).toUpperCase()}`;
}

function evaluateBehavioralStep({ manifest, state, step } = {}) {
  if (!manifest) return { allowed: true, code: null, containment: null, assessment: null };
  const telemetry = state?.behavioralTelemetry;
  const evaluationState = { ...(state || {}), agentId: state?.agentId || manifest?.agentId || 'agent' };
  const observation = observationFor(evaluationState, step, telemetry);
  const assessment = assessBehavior({ baseline: manifest, observation });
  appendTelemetry(state, assessment, observation);
  return {
    allowed: assessment.decision === 'observe',
    code: legacyCodeFor(assessment, observation, step),
    containment: assessment.containment?.action || null,
    assessment,
  };
}

function initializeBehavioralState(state, input = {}) {
  if (!state || typeof state !== 'object') return null;
  const source = input && typeof input === 'object' ? input : {};
  state.agentId ||= text(source.agentId) || 'agent';
  const declaredTools = list(source.selectedTools);
  const capabilities = source.capabilities || [...declaredTools, 'dream', 'dream-experiment-verify'];
  state.behavioralManifest ||= buildBehavioralManifest({
    goal: source.goal,
    workspaceId: source.workspaceId,
    agentId: source.agentId,
    selectedTools: [...declaredTools, 'dream'],
    capabilities,
    connectors: source.connectors,
    targetClasses: source.targetClasses,
    egressClasses: source.egressClasses,
    delegation: source.delegation,
  });
  state.behavioralFindings = Array.isArray(state.behavioralFindings) ? state.behavioralFindings : [];
  state.behavioralTelemetry ||= telemetryFromNotes(state.behavioralManifest, state);

  const containmentRecord = [...(Array.isArray(state.notes) ? state.notes : [])]
    .reverse()
    .find(note => note && note.behavioralContainment)?.behavioralContainment;
  if (containmentRecord && !state.behavioralContainment) {
    state.behavioralContainment = runtimeFor(state).record({
      workspaceId: containmentRecord.scope?.workspaceId || state.workspaceId,
      agentId: containmentRecord.scope?.agentId || state.agentId,
      action: containmentRecord.action,
      reason: containmentRecord.reason,
      baselineHash: containmentRecord.baselineHash,
      deviationCode: containmentRecord.deviationCode,
    });
  }
  return state.behavioralManifest;
}

function behavioralBlockResult(state, step) {
  const runtime = runtimeFor(state);
  const guard = runtime?.guardExecution({ workspaceId: state.workspaceId, agentId: state.agentId });
  if (guard && !guard.allowed) {
    state.behavioralContainment = guard.state;
    return blockedResult({
      state,
      code: guard.code,
      containment: guard.state?.action || 'revoke',
      runtimeState: guard.state,
    });
  }

  const behavioral = evaluateBehavioralStep({ manifest: state.behavioralManifest, state, step });
  if (behavioral.allowed) return null;
  const assessment = behavioral.assessment;
  const contained = runtime?.record({
    workspaceId: state.workspaceId,
    agentId: state.agentId,
    action: behavioral.containment,
    reason: assessment?.deviationCode || behavioral.code,
    baselineHash: state.behavioralManifest?.baselineHash || null,
    deviationCode: assessment?.deviationCode || behavioral.code,
  });
  if (contained?.ok) {
    state.behavioralContainment = contained;
    containmentNote(state, contained);
  }
  return blockedResult({
    state,
    code: behavioral.code,
    containment: behavioral.containment,
    assessment,
    runtimeState: contained?.ok ? contained : null,
  });
}

module.exports = {
  MANIFEST_VERSION,
  buildBehavioralManifest,
  evaluateBehavioralStep,
  initializeBehavioralState,
  behavioralBlockResult,
};
