'use strict';

// What happens after a completed agent step, shared by the V1 loop
// (lib/agent-step-executor.js) and the V3 loop (agent.v3.js): recording the
// report, the stalled-progress counter, the forced Dream when progress stalls,
// and the follow-up / failure-fallback choice. Each loop keeps its own control
// flow around these calls (V3's repair, uncertain-operation, blocked and Dream
// experiment handling) and its own rationale wording, which shows up in run
// results and is part of their output.

const { normalizeSummaryText } = require('./agent-memory-state');
const { scheduleCandidates } = require('./cognitive-scheduler');

const STALLED_RATIONALE = 'Progress stalled; switching to hypothesis mode.';
const STALLS_BEFORE_DREAM = 2;
// #3494: STALLS_BEFORE_DREAM is where the Dream recovery is triggered; when
// progress still has not moved two steps later, the run stops as stalled
// instead of spending its step and iteration ceilings. (A Dream already in
// the queue suppresses the forced one, and repeating follow-ups can keep it
// waiting, so the stop does not wait for a Dream to have run.)
const STALLS_BEFORE_STOP = STALLS_BEFORE_DREAM + 2;

function stalledBeyondRecovery(state) {
  return Boolean(state.progress) && state.progress.stalledCount >= STALLS_BEFORE_STOP;
}

// A stall stops the run only while work is still queued: with nothing left,
// the loop ends on its own and keeps its terminal status.
function shouldStopStalled(state, queued) {
  return Array.isArray(queued) && queued.length > 0 && stalledBeyondRecovery(state);
}

/**
 * #3311: reorder a run's already-eligible queued steps through the opt-in
 * cognitive scheduler. Returns null (and leaves `queued` untouched) unless the
 * caller passed `opts.cognitiveScheduler`, so a default run keeps its exact
 * FIFO order. A pending repair is never reordered ahead of its guard. The
 * scheduler only orders the candidate set the plan already produced; steps a
 * follow-up or the Dream loop append mid-run keep their existing front-of-queue
 * priority.
 *
 * The scheduler decides an *order*, never which work exists. When it does not
 * select the whole queue -- a budget, depth or risk-ceiling omission -- the
 * queue is left exactly as the plan built it: reordering only the selected
 * subset would drop the omitted steps from the checkpoint, and the finalizer
 * would then report `completed` with planned work still owed.
 */
function scheduleQueuedSteps({ state, queued, opts = {}, goal = '', objective = '' }) {
  const config = opts.cognitiveScheduler;
  if (!config || typeof config !== 'object' || queued.length <= 1 || state.pendingRepair) return null;
  const keys = queued.map((step, index) => step.id || `${step.action || step.tool || 'step'}-${index}`);
  const candidates = queued.map((step, index) => ({
    key: keys[index],
    family: step.tool || step.action || 'unknown',
    urgency: step.urgency,
    riskTier: step.riskTier,
    cost: step.cost,
  }));
  const result = scheduleCandidates(
    { candidates, goal, objective, budget: config.budget },
    { ...config, tieBreak: config.tieBreak || 'input-order' },
  );
  if (result.status !== 'ok') return result;
  const selected = new Set(result.order);
  if (selected.size !== queued.length) {
    return { ...result, deferred: keys.filter((key) => !selected.has(key)), applied: false };
  }
  const byKey = new Map(queued.map((step, index) => [keys[index], step]));
  const reordered = result.order.map((key) => byKey.get(key));
  queued.length = 0;
  queued.push(...reordered);
  return { ...result, deferred: [], applied: true };
}

function recordStepReport(runtime, state, report) {
  state.steps.push(report);
  state.evidence.push(...runtime.collectEvidence([report.result]));
  runtime.updateToolStats(report.tool, report.status);
  state.notes.push({ step: report.action, summary: report.summary });
}

/** Update state.progress from the report and return its extracted summary. */
function advanceProgress(runtime, state, report) {
  const summary = runtime.extractAgentSummary(report.result);
  const stalled = runtime.isStalledProgress(state.progress?.lastSummary || '', summary.text);
  state.progress = {
    stalledCount: stalled ? (state.progress?.stalledCount || 0) + 1 : 0,
    lastSummary: normalizeSummaryText(summary.text),
  };
  return summary;
}

function shouldForceDream(state, queued, maxSteps) {
  return state.progress.stalledCount >= STALLS_BEFORE_DREAM &&
    state.steps.length < maxSteps &&
    !queued.some(candidate => candidate.tool === 'dream');
}

/**
 * Put the next step at the front of the queue: a Dream when progress stalled,
 * otherwise the follow-up, or a Dream fallback when that follow-up failed
 * recently. Nothing is queued when neither applies.
 *
 * @param {object} args
 * @param {{ fallback: string, followUp: string }} args.rationales wording the
 *   calling loop reports for a fallback step and a follow-up step
 */
function queueFollowUp({ runtime, state, queued, maxSteps, forceDream, followUp, rationales }) {
  const nextIndex = state.steps.length + 1;
  if (forceDream) {
    queued.unshift({ id: `dream-${nextIndex}`, action: 'dream', tool: 'dream', input: {}, rationale: STALLED_RATIONALE });
    return;
  }
  if (!followUp || state.steps.length >= maxSteps) return;
  if (!runtime.findRecentFailure(runtime.stepSignature(followUp, state))) {
    queued.unshift({ id: `${followUp.action}-${nextIndex}`, action: followUp.action, tool: followUp.tool, input: followUp.input, rationale: rationales.followUp });
    return;
  }
  if (followUp.action === 'dream') return;
  const fallback = { action: 'dream', tool: 'dream', input: {}, rationale: rationales.fallback };
  if (!runtime.findRecentFailure(runtime.stepSignature(fallback, state))) {
    queued.unshift({ id: `${fallback.action}-${nextIndex}`, ...fallback });
  }
}

module.exports = {
  STALLS_BEFORE_DREAM,
  STALLS_BEFORE_STOP,
  stalledBeyondRecovery,
  shouldStopStalled, recordStepReport, advanceProgress, shouldForceDream, queueFollowUp, scheduleQueuedSteps };
