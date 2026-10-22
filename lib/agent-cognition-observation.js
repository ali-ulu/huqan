'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { stableStringify } = require('./hash-chain');
const { validateReferenceFrame } = require('./memory-cognitive-message');
const { observeFile, compareObservations } = require('./file-effect-sensor');
const { fromFileEffect } = require('./cognition/percept-adapters');
const { buildPercept } = require('./cognition/percept');
const { recordPrediction, recordOutcome } = require('./prediction-outcome-pairs');
const { freezeResult } = require('./cognition/contract');

const hash = value => createHash('sha256').update(stableStringify(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
function frameHashOf(frame) {
  return validateReferenceFrame(frame).ok ? hash(frame) : null;
}

// Only host opts declare the expectation. Tool input and reported success are not evidence.
function artifactExpectation({ state, step, opts }) {
  try {
    const declared = opts.cognitionFileExpectations?.[step.id];
    const frameHash = frameHashOf(opts.cognitionFrame);
    if (!declared || declared.workspaceId !== state.workspaceId || !frameHash || opts.cognitionFrame.goal !== state.goal
      || !text(declared.sourceGroup) || !/^[a-f0-9]{64}$/.test(declared.expectedDigest)) return null;
    const target = fs.realpathSync(declared.path);
    const before = observeFile(target);
    if (before.state !== 'digested') return null;
    const decisionId = hash([state.workspaceId, state.observabilityRunId, step.id, frameHash]);
    const expectationHash = hash({ target, expectedDigest: declared.expectedDigest, frame: opts.cognitionFrame });
    const percept = buildPercept({ modality: 'file-effect', provenance: 'observed', frame: opts.cognitionFrame,
      message: { source: 'file-effect-sensor', target: 'cognition', workspace: state.workspaceId,
        goal: state.goal, traceId: step.id, observation: { target: hash(target), digest: before.digest },
        prediction: { expectedDigest: declared.expectedDigest }, hypothesis: null, action: step.tool || step.action,
        confidence: null, evidenceRefs: [`artifact:${hash(target)}`], temporalContext: null, budget: null } });
    if (percept.status !== 'MEASURED') return null;
    const binding = { workspaceId: state.workspaceId, runId: state.observabilityRunId, stepId: step.id,
      frameHash, expectationHash, perceptKey: percept.perceptKey,
      sourceGroup: declared.sourceGroup, sourceRefs: [`artifact:${hash(target)}`] };
    return freezeResult({ decisionId, binding, target, declaredPath: declared.path, before,
      expectedDigest: declared.expectedDigest, frame: opts.cognitionFrame, riskScore: declared.riskScore ?? null });
  } catch (_) { return null; }
}
function beginObservation(args) {
  const pending = artifactExpectation(args);
  if (!pending) return null;
  try {
    recordPrediction(args.graph, { decisionId: pending.decisionId, score: pending.riskScore,
      unknown: pending.riskScore === null ? 'artifact_risk_unknown' : '',
      actionClass: args.step.tool || args.step.action, binding: pending.binding });
    return pending;
  } catch (_) { return null; }
}

function finishObservation({ graph, state, step, report, pending }) {
  const abstain = reason => ({ status: 'ABSTAIN', reason });
  if (!pending || report?.status === 'blocked') return abstain('independent_observation_unavailable');
  try {
    if (pending.binding.workspaceId !== state.workspaceId || pending.binding.runId !== state.observabilityRunId
      || pending.binding.stepId !== step.id || fs.realpathSync(pending.declaredPath) !== pending.target)
      return abstain('observation_binding_mismatch');
    const after = observeFile(pending.target);
    if (after.state !== 'digested') return abstain('indeterminate_artifact');
    const at = new Date().toISOString();
    const percept = fromFileEffect({ fileEffect: { observation: compareObservations(pending.before, after) },
      path: pending.binding.sourceRefs[0], frame: pending.frame, workspace: state.workspaceId,
      traceId: pending.decisionId, evidenceRefs: pending.binding.sourceRefs, observedAt: at });
    if (percept.status !== 'MEASURED') return abstain('invalid_percept');
    // Confirmation is of this predeclared artifact digest, never general task success.
    const outcome = after.digest === pending.expectedDigest ? 'confirmed' : 'contradiction';
    const result = recordOutcome(graph, { decisionId: pending.decisionId, outcome,
      idempotencyKey: pending.decisionId, at });
    return { status: 'MEASURED', reason: result.replayed ? 'artifact_outcome_replayed' : 'artifact_digest_observed',
      outcome: result.outcome, decisionId: pending.decisionId, replayed: result.replayed,
      perceptKey: pending.binding.perceptKey };
  } catch (_) { return abstain('observation_unavailable'); }
}
module.exports = { frameHashOf, artifactExpectation, beginObservation, finishObservation };
