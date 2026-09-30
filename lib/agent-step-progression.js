'use strict';

// What happens after a completed agent step, shared by the V1 loop
// (lib/agent-step-executor.js) and the V3 loop (agent.v3.js): recording the
// report, the stalled-progress counter, the forced Dream when progress stalls,
// and the follow-up / failure-fallback choice. Each loop keeps its own control
// flow around these calls (V3's repair, uncertain-operation, blocked and Dream
// experiment handling) and its own rationale wording, which shows up in run
// results and is part of their output.

const { normalizeSummaryText } = require('./agent-memory-state');

const STALLED_RATIONALE = 'Progress stalled; switching to hypothesis mode.';
const STALLS_BEFORE_DREAM = 2;

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

module.exports = { recordStepReport, advanceProgress, shouldForceDream, queueFollowUp };
