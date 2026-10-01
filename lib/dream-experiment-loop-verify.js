'use strict';

// Verification-signal shaping and verified-hypothesis commit path for
// lib/dream-experiment-loop.js (#2120): semantic/causal signal combination and
// the durable background-edge commit live here; the entry file owns loop state.

const { CausalSimulator } = require('../causalSimulator');
const { boundedText, boundedConfidence, MAX_TEXT } = require('./dream-experiment-loop-hypotheses');

function signalFromVerification(report = {}) {
  const data = report?.result?.data || report?.result?.output || report?.data || {};
  const status = boundedText(data.status || report?.summary || '', 40).toLowerCase();
  if (status === 'verified' || status === 'support' || status === 'supported') return 'support';
  if (status === 'contradicted' || status === 'reject' || status === 'rejected') return 'reject';
  return 'unknown';
}

function simulateHypothesis(kernel, state, hypothesis, context = {}) {
  try {
    const simulator = context.causalSimulator || new CausalSimulator(kernel?.graph);
    const result = simulator.simulateChange({
      action: `Evaluate Dream hypothesis ${hypothesis.key}`,
      nodeId: hypothesis.from,
      changeType: 'modify',
      newState: { active: true },
      maxDepth: 10,
      workspaceId: state.workspaceId,
    });
    const affectedNodes = Array.isArray(result?.affectedNodes) ? result.affectedNodes : [];
    const target = affectedNodes.find(item => item?.nodeId === hypothesis.to) || null;
    return {
      signal: target ? 'support' : 'unknown',
      mode: boundedText(result?.mode || (result?.ok === false ? 'error' : 'unknown'), 40),
      confidence: boundedConfidence(target?.confidence ?? result?.confidence),
      impact: boundedConfidence(target?.impact),
      targetFound: Boolean(target),
      causalChains: Number.isInteger(result?.causalChains) ? Math.max(0, result.causalChains) : 0,
      errorCode: boundedText(result?.error?.code || '', 80),
    };
  } catch (error) {
    return {
      signal: 'unknown',
      mode: 'error',
      confidence: 0,
      impact: 0,
      targetFound: false,
      causalChains: 0,
      errorCode: boundedText(error?.code || 'CAUSAL_SIMULATION_FAILED', 80),
    };
  }
}

function combineVerificationSignals(semanticSignal, causalSignal) {
  if (semanticSignal === 'reject') return 'reject';
  if (semanticSignal === 'support' && causalSignal === 'support') return 'support';
  return 'unknown';
}

function commitVerifiedHypothesis(kernel, state, hypothesis, observation, context = {}) {
  if (observation.signal !== 'support') {
    return { ok: true, decision: 'not_applicable', edge: null, admission: null };
  }
  if (typeof kernel?.commitBackgroundEdge !== 'function' || typeof kernel?.graph?.runMutationOnce !== 'function') {
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
    const mutation = kernel.graph.runMutationOnce(operationId, () => kernel.commitBackgroundEdge(
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

module.exports = {
  signalFromVerification,
  simulateHypothesis,
  combineVerificationSignals,
  commitVerifiedHypothesis,
};
