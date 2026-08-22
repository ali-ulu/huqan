'use strict';

const crypto = require('crypto');
const { normalizeWorkspaceId } = require('./workspace-id');

const DREAM_EXPERIMENT_LOOP_VERSION = 'DEL-v1.0.0';
const MAX_HYPOTHESES = 10;
const DEFAULT_MAX_HYPOTHESES = 3;
const DEFAULT_MAX_CYCLES = 2;
const MAX_TEXT = 240;

function boundedText(value, max = MAX_TEXT) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return text.slice(0, max);
}

function boundedConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function relationForHypothesis(hypothesis = {}) {
  if (['tür', 'yapabilir', 'özellik', 'benzer', 'hipotez'].includes(hypothesis.relation)) {
    return hypothesis.relation;
  }
  if (hypothesis.via === 'tür') return 'tür';
  if (hypothesis.via === 'yapabilir') return 'yapabilir';
  if (hypothesis.via === 'özellik') return 'özellik';
  if (hypothesis.type === 'zincir' || hypothesis.type === 'benzerlik') return 'benzer';
  return 'hipotez';
}

function normalizeHypothesis(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const from = boundedText(raw.from || raw.subject || raw.node, 120);
  const to = boundedText(raw.to || raw.target, 120);
  if (!from || !to) return null;
  const relation = relationForHypothesis(raw);
  const type = boundedText(raw.type || raw.via || 'hypothesis', 60) || 'hypothesis';
  const confidence = boundedConfidence(raw.confidence);
  const key = hashId(`${from}|${relation}|${to}`);
  return {
    key,
    from,
    to,
    relation,
    type,
    via: boundedText(raw.via || '', 60),
    confidence,
    claim: `${from} ${relation} ${to}`.slice(0, MAX_TEXT),
  };
}

function extractHypotheses(dreamResult) {
  const candidates = Array.isArray(dreamResult)
    ? dreamResult
    : Array.isArray(dreamResult?.data?.hypotheses)
      ? dreamResult.data.hypotheses
      : Array.isArray(dreamResult?.hypotheses)
        ? dreamResult.hypotheses
        : [];
  const seen = new Set();
  return candidates
    .map(normalizeHypothesis)
    .filter(Boolean)
    .filter(item => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .sort((left, right) => right.confidence - left.confidence || left.key.localeCompare(right.key))
    .slice(0, MAX_HYPOTHESES);
}

function createExperimentId(state = {}, opts = {}) {
  if (state.experimentId) return boundedText(state.experimentId, 80);
  if (opts.experimentId) return boundedText(opts.experimentId, 80);
  const seed = [
    normalizeWorkspaceId(opts.workspaceId || state.workspaceId),
    boundedText(opts.checkpointId || state.checkpointId || state.goal || 'dream', 160),
    DREAM_EXPERIMENT_LOOP_VERSION,
  ].join('|');
  return `exp_${hashId(seed)}`;
}

function createInitialState({ workspaceId = 'default', goal = '', checkpointId = '', maxHypotheses, maxCycles, experimentId } = {}) {
  const boundedMaxHypotheses = Number.isInteger(maxHypotheses)
    ? Math.max(1, Math.min(MAX_HYPOTHESES, maxHypotheses))
    : DEFAULT_MAX_HYPOTHESES;
  const boundedMaxCycles = Number.isInteger(maxCycles)
    ? Math.max(1, Math.min(5, maxCycles))
    : DEFAULT_MAX_CYCLES;
  return {
    version: DREAM_EXPERIMENT_LOOP_VERSION,
    experimentId: experimentId || createExperimentId({ workspaceId, goal, checkpointId }, { workspaceId, checkpointId }),
    workspaceId: normalizeWorkspaceId(workspaceId),
    goal: boundedText(goal, MAX_TEXT),
    phase: 'idle',
    status: 'idle',
    cycle: 0,
    maxCycles: boundedMaxCycles,
    maxHypotheses: boundedMaxHypotheses,
    hypotheses: [],
    attempted: [],
    observations: [],
    transitionSeq: 0,
    nextAction: null,
    terminalReason: null,
    lastError: null,
  };
}

function ensureState(state = {}, context = {}) {
  const base = createInitialState({
    workspaceId: context.workspaceId || state.workspaceId,
    goal: context.goal || state.goal,
    checkpointId: context.checkpointId || state.checkpointId,
    maxHypotheses: context.maxHypotheses || state.maxHypotheses,
    maxCycles: context.maxCycles || state.maxCycles,
    experimentId: state.experimentId || context.experimentId,
  });
  return {
    ...base,
    ...cloneValue(state),
    experimentId: state.experimentId || base.experimentId,
    workspaceId: normalizeWorkspaceId(state.workspaceId || base.workspaceId),
    hypotheses: Array.isArray(state.hypotheses) ? state.hypotheses : [],
    attempted: Array.isArray(state.attempted) ? state.attempted : [],
    observations: Array.isArray(state.observations) ? state.observations : [],
    transitionSeq: Number.isInteger(state.transitionSeq) && state.transitionSeq >= 0 ? state.transitionSeq : 0,
  };
}

function nextHypothesis(state) {
  const attempted = new Set(state.attempted || []);
  return (state.hypotheses || []).find(item => item && !attempted.has(item.key)) || null;
}

function buildVerificationStep(state, hypothesis) {
  return {
    id: `dream-experiment-verify-${state.experimentId}-${state.transitionSeq + 1}`.slice(0, 180),
    action: 'dream-experiment-verify',
    tool: 'verify',
    input: hypothesis.claim,
    rationale: 'Dream hypothesis is being checked through the existing Agent Action Firewall and kernel.verify path.',
    dreamExperiment: {
      experimentId: state.experimentId,
      hypothesisKey: hypothesis.key,
      cycle: state.cycle,
    },
  };
}

function persistTransition(kernel, state, transition) {
  const graph = kernel?.graph;
  if (!graph || typeof graph.runMutationOnce !== 'function' || typeof graph.appendAuditEvent !== 'function') {
    return {
      ok: false,
      decision: 'review',
      error: {
        code: 'DREAM_EXPERIMENT_DURABILITY_UNAVAILABLE',
        message: 'Dream experiment transition durability is unavailable; refusing to advance the loop.',
      },
    };
  }

  const nextSeq = state.transitionSeq + 1;
  const operationId = `dream-experiment:${state.experimentId}:${nextSeq}`;
  const safeTransition = {
    loopVersion: DREAM_EXPERIMENT_LOOP_VERSION,
    experimentId: state.experimentId,
    workspaceId: state.workspaceId,
    sequence: nextSeq,
    phase: boundedText(transition.phase, 80),
    status: boundedText(transition.status, 80),
    cycle: Number.isInteger(transition.cycle) ? transition.cycle : state.cycle,
    hypothesisKey: boundedText(transition.hypothesisKey || '', 80),
    signal: boundedText(transition.signal || '', 40),
    nextAction: boundedText(transition.nextAction || '', 80),
    reason: boundedText(transition.reason || '', MAX_TEXT),
    evidenceCount: Array.isArray(transition.evidence) ? Math.min(transition.evidence.length, 8) : 0,
  };

  try {
    const result = graph.runMutationOnce(operationId, () => {
      const audit = graph.appendAuditEvent({
        eventType: 'QUERY',
        targetType: 'dream_experiment',
        targetId: state.experimentId,
        workspaceId: state.workspaceId,
        actor: 'agent-dream-experiment-loop',
        sourceRef: 'kernel.dream-experiment-loop',
        details: safeTransition,
      });
      return {
        operationId,
        transition: safeTransition,
        auditId: audit?.auditId || null,
      };
    });
    return {
      ok: true,
      decision: 'allow',
      replayed: Boolean(result?.replayed),
      result: result?.result || null,
      operationId,
    };
  } catch (error) {
    return {
      ok: false,
      decision: 'review',
      operationId,
      error: {
        code: error?.code || 'DREAM_EXPERIMENT_TRANSITION_FAILED',
        message: boundedText(error?.message || 'Dream experiment transition failed.', MAX_TEXT),
      },
    };
  }
}

function startFromDreamResult(kernel, currentState, dreamResult, context = {}) {
  const state = ensureState(currentState, context);
  const hypotheses = extractHypotheses(dreamResult).slice(0, state.maxHypotheses);
  state.cycle += 1;
  state.hypotheses = hypotheses;
  state.attempted = [];
  state.phase = 'hypothesis_generated';
  state.status = hypotheses.length ? 'running' : 'completed';
  state.nextAction = hypotheses.length ? 'verify' : null;
  state.terminalReason = hypotheses.length ? null : 'no_bounded_hypotheses';
  state.lastError = null;

  if (state.cycle > state.maxCycles) {
    state.status = 'completed';
    state.phase = 'terminal';
    state.nextAction = null;
    state.terminalReason = 'max_cycles_reached';
  }

  const first = nextHypothesis(state);
  const transition = persistTransition(kernel, state, {
    phase: state.phase,
    status: state.status,
    cycle: state.cycle,
    hypothesisKey: first?.key,
    nextAction: state.nextAction,
    reason: state.terminalReason || 'bounded hypothesis set generated',
    evidence: dreamResult?.evidence,
  });
  if (!transition.ok) {
    state.status = 'blocked';
    state.phase = 'blocked';
    state.nextAction = null;
    state.lastError = transition.error;
    return { state, handled: true, blocked: true, nextStep: null, transition };
  }
  state.transitionSeq += 1;

  return {
    state,
    handled: true,
    blocked: false,
    nextStep: state.status === 'running' && first ? buildVerificationStep(state, first) : null,
    transition,
  };
}

function signalFromVerification(report = {}) {
  const data = report?.result?.data || report?.result?.output || report?.data || {};
  const status = boundedText(data.status || report?.summary || '', 40).toLowerCase();
  if (status === 'verified' || status === 'support' || status === 'supported') return 'support';
  if (status === 'contradicted' || status === 'reject' || status === 'rejected') return 'reject';
  return 'unknown';
}

function commitVerifiedHypothesis(kernel, state, hypothesis, observation, context = {}) {
  if (observation.signal !== 'support') {
    return { ok: true, decision: 'not_applicable', edge: null, admission: null };
  }
  if (typeof kernel?._commitBackgroundEdge !== 'function' || typeof kernel?.graph?.runMutationOnce !== 'function') {
    return {
      ok: false,
      decision: 'review',
      error: {
        code: 'DREAM_EXPERIMENT_EDGE_DURABILITY_UNAVAILABLE',
        message: 'Verified hypothesis has no durable background-edge commit path; refusing the canonical write.',
      },
    };
  }

  const operationId = `dream-experiment:edge:${state.experimentId}:${hypothesis.key}`;
  try {
    const mutation = kernel.graph.runMutationOnce(operationId, () => kernel._commitBackgroundEdge(
      hypothesis.from,
      hypothesis.to,
      hypothesis.relation,
      'dreamExperiment',
      {
        workspaceId: state.workspaceId,
        provenanceExtra: {
          sourceSubType: 'verified_hypothesis',
          sourceRef: `dream-experiment:${state.experimentId}`,
          hypothesisKey: hypothesis.key,
          observationSignal: observation.signal,
        },
        admissionOpts: {
          ...(context.admissionOpts && typeof context.admissionOpts === 'object' ? context.admissionOpts : {}),
          admissionContext: {
            ...((context.admissionOpts && typeof context.admissionOpts.admissionContext === 'object')
              ? context.admissionOpts.admissionContext
              : {}),
            dreamExperimentId: state.experimentId,
            hypothesisKey: hypothesis.key,
            observationSignal: observation.signal,
          },
        },
        edgeOptions: {
          source: 'background:dreamExperiment',
        },
      },
    ));
    const result = mutation?.result || null;
    return {
      ok: true,
      decision: result?.decision || 'review',
      edge: result?.edge || null,
      admission: result?.admission || null,
      replayed: Boolean(mutation?.replayed),
      operationId,
    };
  } catch (error) {
    return {
      ok: false,
      decision: 'review',
      operationId,
      error: {
        code: error?.code || 'DREAM_EXPERIMENT_EDGE_COMMIT_FAILED',
        message: boundedText(error?.message || 'Verified hypothesis edge commit failed.', MAX_TEXT),
      },
    };
  }
}

function advanceAfterVerification(kernel, currentState, report, context = {}) {
  const state = ensureState(currentState, context);
  const hypothesisKey = boundedText(report?.step?.dreamExperiment?.hypothesisKey || report?.dreamExperiment?.hypothesisKey || context.hypothesisKey || '', 80);
  const hypothesis = state.hypotheses.find(item => item.key === hypothesisKey) || nextHypothesis(state);
  if (!hypothesis) {
    state.status = 'completed';
    state.phase = 'terminal';
    state.nextAction = null;
    state.terminalReason = 'hypothesis_set_exhausted';
    return { state, handled: true, blocked: false, nextStep: null, transition: null };
  }

  const signal = signalFromVerification(report);
  const observation = {
    hypothesisKey: hypothesis.key,
    signal,
    status: boundedText(report?.result?.data?.status || report?.status || 'unknown', 40),
    confidence: boundedConfidence(report?.result?.data?.confidence ?? report?.confidence),
  };
  const edgeCommit = commitVerifiedHypothesis(kernel, state, hypothesis, observation, context);
  if (!edgeCommit.ok) {
    state.status = 'blocked';
    state.phase = 'blocked';
    state.nextAction = null;
    state.lastError = edgeCommit.error;
    return {
      state,
      handled: true,
      blocked: true,
      nextStep: null,
      transition: edgeCommit,
    };
  }
  observation.commitDecision = boundedText(edgeCommit.decision || 'not_applicable', 40);
  state.attempted = Array.from(new Set([...(state.attempted || []), hypothesis.key])).slice(0, MAX_HYPOTHESES);
  state.observations = [...(state.observations || []), observation].slice(-MAX_HYPOTHESES);

  const following = nextHypothesis(state);
  if (following) {
    state.phase = 'observation_analyzed';
    state.status = 'running';
    state.nextAction = 'verify';
    state.terminalReason = null;
  } else if (state.cycle < state.maxCycles) {
    state.phase = 'observation_analyzed';
    state.status = 'running';
    state.nextAction = 'dream';
    state.terminalReason = 'request_next_hypothesis_cycle';
  } else {
    state.phase = 'terminal';
    state.status = 'completed';
    state.nextAction = null;
    state.terminalReason = 'bounded_hypothesis_cycles_exhausted';
  }

  const transition = persistTransition(kernel, state, {
    phase: state.phase,
    status: state.status,
    cycle: state.cycle,
    hypothesisKey: hypothesis.key,
    signal,
    nextAction: state.nextAction,
    reason: `${state.terminalReason || 'next bounded hypothesis selected'};edge=${observation.commitDecision}`,
    evidence: report?.result?.evidence,
  });
  if (!transition.ok) {
    state.status = 'blocked';
    state.phase = 'blocked';
    state.nextAction = null;
    state.lastError = transition.error;
    return { state, handled: true, blocked: true, nextStep: null, transition };
  }
  state.transitionSeq += 1;

  if (state.nextAction === 'verify' && following) {
    return { state, handled: true, blocked: false, nextStep: buildVerificationStep(state, following), transition };
  }
  if (state.nextAction === 'dream') {
    return {
      state,
      handled: true,
      blocked: false,
      nextStep: {
        id: `dream-experiment-dream-${state.experimentId}-${state.transitionSeq + 1}`.slice(0, 180),
        action: 'dream',
        tool: 'dream',
        input: {},
        rationale: 'The bounded hypothesis set was observed; request the next Dream hypothesis cycle.',
        dreamExperiment: { experimentId: state.experimentId, cycle: state.cycle + 1 },
      },
      transition,
    };
  }
  return { state, handled: true, blocked: false, nextStep: null, transition };
}

function isDreamExperimentVerificationStep(step = {}) {
  return step.action === 'dream-experiment-verify' && step.tool === 'verify';
}

function loopEnabled(opts = {}, kernel = null) {
  if (opts.dreamExperimentLoop !== true) return false;
  if (!kernel || !kernel.graph || typeof kernel.graph.runMutationOnce !== 'function') return false;
  return true;
}

module.exports = {
  DREAM_EXPERIMENT_LOOP_VERSION,
  MAX_HYPOTHESES,
  DEFAULT_MAX_HYPOTHESES,
  DEFAULT_MAX_CYCLES,
  boundedText,
  boundedConfidence,
  extractHypotheses,
  normalizeHypothesis,
  createInitialState,
  ensureState,
  buildVerificationStep,
  startFromDreamResult,
  advanceAfterVerification,
  commitVerifiedHypothesis,
  isDreamExperimentVerificationStep,
  loopEnabled,
  persistTransition,
};
