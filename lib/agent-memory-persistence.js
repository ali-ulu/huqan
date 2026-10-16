'use strict';

// Tracks agent memory-persistence health across a run (#1985).
//
// agent.js used to swallow every memory-write failure inside catch(_){} and
// still report ok:true, so a run could lose its goals/runs/file snapshot
// while looking successful. These helpers record each failure on the agent
// instance; run() copies the verdict into the result envelope as
// meta.memoryPersisted / meta.memoryErrors (mirroring agent.v3's
// _storageFailure pattern, without changing v1's ok:true contract).

function resetMemoryPersistence(agent) {
  if (!agent) return;
  agent._memoryPersisted = true;
  agent._memoryErrors = [];
}

function noteMemoryFailure(agent, operation, error) {
  if (!agent) return;
  agent._memoryPersisted = false;
  if (!Array.isArray(agent._memoryErrors)) agent._memoryErrors = [];
  agent._memoryErrors.push({
    operation: String(operation || 'unknown'),
    message: (error && error.message) || String(error),
    code: (error && error.code) || null,
  });
}

function memoryPersistenceMeta(agent) {
  return {
    memoryPersisted: !agent || agent._memoryPersisted !== false,
    memoryErrors: Array.isArray(agent && agent._memoryErrors) ? agent._memoryErrors : [],
  };
}

// #1987: run() used to look only at the final step, so a fail+success
// matrix reported ok:true completed with no trace of the intermediate
// error. Summarize every step so callers can tell "clean run" apart from
// "succeeded despite step errors". Status itself is unchanged on purpose:
// callers already branch on completed/blocked/paused, and inventing a new
// terminal status here would silently re-route them.
function summarizeStepErrors(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const stepErrorCount = list.filter(
    (step) => step && (step.status === 'error' || (step.result && step.result.ok === false)),
  ).length;
  return { hasStepErrors: stepErrorCount > 0, stepErrorCount };
}

// Attach the summary to run state (v3 returns state as result data, so the
// flag rides along with zero envelope changes).
function attachStepErrorSummary(state) {
  if (!state) return state;
  const summary = summarizeStepErrors(state.steps);
  state.hasStepErrors = summary.hasStepErrors;
  state.stepErrorCount = summary.stepErrorCount;
  return state;
}

// Combined envelope meta for v1 run(): persistence health + step errors.
function runEnvelopeMeta(agent, steps) {
  return { ...memoryPersistenceMeta(agent), ...summarizeStepErrors(steps) };
}

module.exports = {
  attachStepErrorSummary,
  memoryPersistenceMeta,
  noteMemoryFailure,
  resetMemoryPersistence,
  runEnvelopeMeta,
  summarizeStepErrors,
};
