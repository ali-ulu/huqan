'use strict';
const fs = require('node:fs');
const path = require('node:path');
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

// Bind missing leaves to real directory identities, not merely a lexical path.
// New ordinary directories may appear; no component may become a link.
function artifactPath(declaredPath, anchors) {
  if (typeof declaredPath !== 'string' || !path.isAbsolute(declaredPath)
    || declaredPath.includes('\0') || declaredPath.split(/[\\/]/u).includes('..')) throw new Error('invalid_artifact_path');
  const absolute = path.resolve(declaredPath);
  const directories = [];
  for (let current = absolute; ; current = path.dirname(current)) {
    let stat;
    try { stat = fs.lstatSync(current, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) throw new Error('artifact_path_link');
      if (stat.isDirectory()) directories.push({ path: current, dev: String(stat.dev), ino: String(stat.ino),
        real: fs.realpathSync.native(current) });
    }
    if (current === path.dirname(current)) break;
  }
  if (!directories.length) throw new Error('artifact_anchor_missing');
  if (anchors && anchors.some(anchor => !directories.some(current => current.path === anchor.path
    && current.dev === anchor.dev && current.ino === anchor.ino && current.real === anchor.real)))
    throw new Error('artifact_anchor_changed');
  const nearest = directories[0];
  const target = fs.existsSync(absolute) ? fs.realpathSync.native(absolute)
    : path.join(nearest.real, path.relative(nearest.path, absolute));
  return { target, anchors: directories };
}

// Only host opts declare the expectation. Tool input and reported success are not evidence.
function artifactExpectation({ state, step, opts }) {
  try {
    const declared = opts.cognitionFileExpectations?.[step.id];
    const frameHash = frameHashOf(opts.cognitionFrame);
    if (!declared || declared.workspaceId !== state.workspaceId || !frameHash || opts.cognitionFrame.goal !== state.goal
      || !text(declared.sourceGroup) || !/^[a-f0-9]{64}$/.test(declared.expectedDigest)) return null;
    let target, anchors = null;
    try { target = fs.realpathSync(declared.path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const resolved = artifactPath(declared.path);
      target = resolved.target;
      anchors = resolved.anchors;
    }
    const before = observeFile(target);
    if (before.state !== 'digested' && !(anchors && before.state === 'absent')) return null;
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
    return freezeResult({ decisionId, binding, target, anchors, declaredPath: declared.path, before,
      expectedDigest: declared.expectedDigest, frame: opts.cognitionFrame, riskScore: declared.riskScore ?? null });
  } catch (_) { return null; }
}
function expectationForStep(args) {
  const { state, step, opts, coder } = args;
  if (!Object.hasOwn(opts.cognitionCoderExpectations || {}, step.id)) return artifactExpectation(args);
  try {
    if (Object.hasOwn(opts.cognitionFileExpectations || {}, step.id)) return null;
    const frame = opts.cognitionFrame, frameHash = frameHashOf(frame);
    if (!frameHash || frame.goal !== state.goal) return null;
    const decisionId = hash([state.workspaceId, state.observabilityRunId, step.id, frameHash]);
    const descriptor = coder?.observationExpectation({ state, step, decisionId,
      expectation: opts.cognitionCoderExpectations[step.id] });
    if (!descriptor || frame.repo !== descriptor.root || frame.branch !== descriptor.branch
      || frame.commit !== descriptor.head || descriptor.workspaceId !== state.workspaceId) return null;
    const percept = buildPercept({ modality: 'outcome', provenance: 'observed', frame,
      message: { source: 'native-coder-journal', target: 'cognition', workspace: state.workspaceId,
        goal: state.goal, traceId: step.id, observation: { scopeHash: descriptor.scopeHash },
        prediction: { acceptance: 'passed' }, hypothesis: null, action: step.tool || step.action,
        confidence: null, evidenceRefs: [descriptor.sourceRef], temporalContext: null, budget: null } });
    if (percept.status !== 'MEASURED') return null;
    return freezeResult({ kind: 'coder-acceptance', descriptor, decisionId, riskScore: descriptor.riskScore,
      binding: { workspaceId: state.workspaceId, runId: state.observabilityRunId, stepId: step.id,
        frameHash, expectationHash: descriptor.scopeHash, perceptKey: percept.perceptKey,
        sourceGroup: descriptor.sourceGroup, sourceRefs: [descriptor.sourceRef] } });
  } catch { return null; }
}
// #4065 G1: the family cognition learns under. Coder steps are split by the
// kind of work their approved task does (workKind, set by the Coder plan);
// every other step keeps its tool.
function cognitionFamily(step) {
  const base = step?.tool || step?.action || 'unknown';
  const kind = base === 'coder' && typeof step?.workKind === 'string' ? step.workKind.trim() : '';
  return kind ? `coder:${kind}` : base;
}
function beginObservation(args) {
  const pending = expectationForStep(args);
  if (!pending) return null;
  try {
    recordPrediction(args.graph, { decisionId: pending.decisionId, score: pending.riskScore,
      unknown: pending.riskScore === null ? 'artifact_risk_unknown' : '',
      actionClass: cognitionFamily(args.step), binding: pending.binding });
    return pending;
  } catch (_) { return null; }
}

function finishObservation({ graph, state, step, report, pending, coder }) {
  const abstain = reason => ({ status: 'ABSTAIN', reason });
  if (!pending || report?.status === 'blocked') return abstain('independent_observation_unavailable');
  try {
    if (pending.kind === 'coder-acceptance') {
      if (pending.binding.workspaceId !== state.workspaceId || pending.binding.runId !== state.observabilityRunId
        || pending.binding.stepId !== step.id) return abstain('observation_binding_mismatch');
      const observed = coder?.observeAcceptance({ state, step, result: report?.result,
        descriptor: pending.descriptor, decisionId: pending.decisionId });
      if (!observed || observed.scopeHash !== pending.binding.expectationHash
        || observed.sourceRef !== pending.binding.sourceRefs[0]) return abstain('sealed_acceptance_unavailable');
      const result = recordOutcome(graph, { decisionId: pending.decisionId, outcome: observed.outcome,
        idempotencyKey: pending.decisionId, at: new Date().toISOString() });
      return { status: 'MEASURED', reason: 'native_acceptance_observed', outcome: result.outcome,
        decisionId: pending.decisionId, replayed: result.replayed, sourceHash: observed.sourceHash,
        perceptKey: pending.binding.perceptKey };
    }
    if (pending.binding.workspaceId !== state.workspaceId || pending.binding.runId !== state.observabilityRunId
      || pending.binding.stepId !== step.id
      || (pending.anchors ? artifactPath(pending.declaredPath, pending.anchors).target
        : fs.realpathSync(pending.declaredPath)) !== pending.target)
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
module.exports = { frameHashOf, artifactExpectation, expectationForStep, beginObservation, finishObservation, cognitionFamily };
