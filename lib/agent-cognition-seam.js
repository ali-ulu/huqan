'use strict';
const { resolveCognitionConfig } = require('./cognition/cognition-config');
const { scoreSalience } = require('./cognition/salience');
const { summarizePredictionErrors } = require('./cognition/prediction-error');
const { fromStepReport } = require('./cognition/percept-adapters');
const { readPredictionErrors } = require('./cognition-prediction-error-pairs');
const { readValueLedger } = require('./cognition-value-ledger-pairs');
const { expectedFor } = require('./cognition/value-ledger');
const { computeRewardSignal } = require('./cognition/reward-signal');
const { freezeResult } = require('./cognition/contract');
const { PAIR_OPERATION_PREFIX, PAIR_STORE_VERSION, readPredictionPairs } = require('./prediction-outcome-pairs');
const { scheduleQueuedSteps } = require('./agent-step-progression');
const { frameHashOf, expectationForStep, beginObservation, finishObservation } = require('./agent-cognition-observation');

const MAX_COGNITION_TRAIL = 32;
const rewardContexts = new WeakMap();
function record(state, entry) {
  state.cognition ||= { trail: [], streak: { family: null, count: 0 } };
  state.cognition.trail = [...(Array.isArray(state.cognition.trail) ? state.cognition.trail : []), entry].slice(-MAX_COGNITION_TRAIL);
  return entry;
}
function enabled(state, opts, observation = false) {
  if (opts.cognition === undefined || opts.cognition === null) return false;
  const config = resolveCognitionConfig(opts.cognition);
  if (config.status === 'REJECT') { record(state, { status: 'REJECT', reason: config.reasons.join(',') }); return false; }
  // Observed reward does not require the optional salience scheduler.
  if (observation && config.flags.reward) return true;
  if (!config.flags.salience) return false;
  if (!opts.cognitiveScheduler || typeof opts.cognitiveScheduler !== 'object' || Array.isArray(opts.cognitiveScheduler)) {
    record(state, { status: 'ABSTAIN', reason: 'salience_without_scheduler' }); return false;
  }
  return true;
}

// Both readers see the same decision-before-observation, workspace/frame-scoped snapshot.
function snapshot(graph, state, frameHash) {
  const rows = graph.getCommittedMutationResultsByPrefix(PAIR_OPERATION_PREFIX);
  if (!Array.isArray(rows)) throw new Error('journal unavailable');
  const at = new Date().toISOString();
  const selected = rows.filter(row => row.result?.workspaceId === state.workspaceId
    && row.result.frameHash === frameHash && Number.isFinite(Date.parse(row.committedAt))
    && Date.parse(row.committedAt) <= Date.parse(at));
  for (const row of selected) {
    const eventAt = row.result.prediction?.at ?? row.result.outcome?.at;
    if (row.result.storeVersion !== PAIR_STORE_VERSION || !Number.isFinite(Date.parse(eventAt))
      || Date.parse(eventAt) > Date.parse(row.committedAt)) throw new Error('invalid journal evidence');
  }
  return { at, priorDecisionIds: selected.filter(row => row.result.outcome).map(row => row.result.decisionId),
    runMutationOnce() { throw new Error('read-only cognition snapshot'); },
    getCommittedMutationResultsByPrefix() { return selected; } };
}

function prepareCognition({ state, queued, opts = {}, goal = '', objective = '', graph, coder }) {
  if (!enabled(state, opts)) return null;
  if (state.pendingRepair || queued.length === 0) return null;
  const frameHash = frameHashOf(opts.cognitionFrame);
  if (!frameHash || opts.cognitionFrame.goal !== (state.goal ?? goal))
    return record(state, { status: 'INSUFFICIENT', reason: 'reference_frame_unavailable' });
  try {
    const source = snapshot(graph, state, frameHash);
    const at = source.at;
    const errors = readPredictionErrors(source);
    const ledger = readValueLedger(source, { workspaceId: state.workspaceId, asOf: at,
      historyBoundary: { at, decisionId: `selection:${state.observabilityRunId}:${state.iteration}`,
        priorDecisionIds: source.priorDecisionIds } });
    if (ledger.status === 'REJECT') return record(state, { status: 'REJECT', reason: ledger.reason });
    const paired = new Set(Object.values(readPredictionPairs(source)).filter(pair => pair.outcome).map(pair => pair.decisionId));
    const candidates = queued.map((step, index) => {
      const family = step.tool || step.action || 'unknown';
      const key = step.id || `${step.action || step.tool || 'step'}-${index}`;
      const value = ledger.entries.find(entry => entry.key === `risk:${family}`);
      const percept = fromStepReport({ report: { step: family, status: 'queued' }, frame: opts.cognitionFrame,
        workspace: state.workspaceId, goal, traceId: key });
      const expectation = expectationForStep({ state, step, opts, coder });
      const perceptKey = expectation?.binding.perceptKey ?? percept.perceptKey;
      const seenCount = expectation ? source.getCommittedMutationResultsByPrefix().filter(row => row.result.prediction
        && row.result.perceptKey === perceptKey && paired.has(row.result.decisionId)).length : undefined;
      return { key, family, perceptKey,
        predictionError: summarizePredictionErrors(errors.errors, { key: `risk:${family}` }),
        riskTier: step.riskTier, arousal: value?.arousal, seenCount, repeats: seenCount };
    });
    const result = scoreSalience({ goal, candidates });
    if (result.status !== 'MEASURED') return record(state, { status: result.status, reason: result.reason });
    const scores = new Map(result.ranked.map(row => [row.key, row.salience]));
    const copies = queued.map((step, index) => ({ ...step,
      urgency: scores.get(candidates[index].key) ?? step.urgency }));
    const scheduled = scheduleQueuedSteps({ state, queued: copies, opts: { ...opts,
      cognitiveScheduler: { ...opts.cognitiveScheduler,
        priorStreak: state.cognition?.streak?.family ? state.cognition.streak : undefined } }, goal, objective });
    if (scheduled?.applied) queued.splice(0, queued.length, ...copies);
    return record(state, { status: 'MEASURED', reason: 'salience_prepared', applied: scheduled?.applied === true,
      ranked: result.ranked.slice(0, 64).map(row => ({ key: row.key, salience: row.salience })),
      values: ledger.entries.slice(0, 64).map(entry => ({ key: entry.key, nObserved: entry.nObserved, nIndependent: entry.nIndependent,
        status: entry.status, value: entry.value, arousal: entry.arousal })) });
  } catch (_) { return record(state, { status: 'INSUFFICIENT', reason: 'journal_unavailable' }); }
}

function beginStepCognition({ state, step, opts = {}, graph, coder }) {
  if (!enabled(state, opts, true)) return null;
  let source;
  if (opts.cognition.reward) {
    try { source = snapshot(graph, state, frameHashOf(opts.cognitionFrame)); } catch { /* Missing history cannot earn a prior. */ }
  }
  const pending = beginObservation({ graph, state, step, opts, coder });
  if (pending && opts.cognition.reward) {
    let context = { state, reason: 'reward_history_unavailable' };
    try {
      if (!source) throw new Error('missing reward snapshot');
      const historyBoundary = { at: source.at, decisionId: pending.decisionId, priorDecisionIds: source.priorDecisionIds };
      const ledger = readValueLedger(source, { workspaceId: state.workspaceId, asOf: source.at, historyBoundary });
      if (ledger.status === 'REJECT') throw new Error('invalid reward history');
      const key = `risk:${step.tool || step.action || 'unknown'}`;
      context = { state, graph, decisionId: pending.decisionId, key, expected: expectedFor(ledger, key),
        history: freezeResult({ workspaceId: state.workspaceId, frameHash: pending.binding.frameHash, historyBoundary }) };
    } catch { /* Observation still runs; reward abstains on an invalid history. */ }
    rewardContexts.set(pending, context);
  }
  state.cognition ||= { trail: [], streak: { family: null, count: 0 } };
  state.cognition.pending = pending;
  return pending;
}
function observeStepCognition({ state, step, report, opts = {}, graph, coder }) {
  if (!enabled(state, opts, true)) return null;
  const pending = state.cognition?.pending;
  const rewardContext = rewardContexts.get(pending);
  rewardContexts.delete(pending);
  if (state.cognition) delete state.cognition.pending;
  const result = finishObservation({ graph, state, step, report, pending, coder });
  if (report && report.status !== 'blocked') {
    const family = step?.tool || step?.action || 'unknown';
    const prior = state.cognition?.streak;
    state.cognition ||= { trail: [] };
    state.cognition.streak = { family, count: prior?.family === family ? Math.min(Number.MAX_SAFE_INTEGER, prior.count + 1) : 1 };
  }
  if (!opts.cognition.reward) return record(state, result);
  const history = rewardContext?.history;
  const valid = rewardContext?.state === state && rewardContext.graph === graph
    && rewardContext.key === `risk:${step.tool || step.action || 'unknown'}` && history?.workspaceId === state.workspaceId
    && history.frameHash === frameHashOf(opts.cognitionFrame)
    && opts.cognitionFrame.goal === state.goal && pending?.binding.runId === state.observabilityRunId
    && pending.binding.stepId === step.id && result.status === 'MEASURED' && !result.replayed
    && result.decisionId === rewardContext.decisionId;
  const reward = valid ? computeRewardSignal({ source: 'prediction-outcome', key: rewardContext.key,
    decisionId: result.decisionId, outcome: result.outcome, expected: rewardContext.expected, at: new Date().toISOString() })
    : freezeResult({ status: 'ABSTAIN', authority: 'SIGNAL_ONLY', reason: rewardContext?.reason || 'bound_observation_unavailable' });
  return record(state, { ...result, reward, rewardHistory: history || null });
}
module.exports = { MAX_COGNITION_TRAIL, prepareCognition, beginStepCognition, observeStepCognition };
