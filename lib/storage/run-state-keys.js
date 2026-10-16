// Goal, goal-memory key and iteration helpers the run-state methods use, and
// the tolerant JSON parse every hydrated row goes through. Moved out of
// storage.js (#2165).

const { normalizeWorkspaceId } = require('../workspace-id');

function normalizeGoal(goal) {
  return String(goal || '').trim();
}

function lower(goal) {
  return normalizeGoal(goal).toLowerCase();
}

/**
 * Workspace-qualified goal-memory key (#757).
 *
 * `key` is goal_memory's PRIMARY KEY and SQLite cannot alter that in place, so
 * the workspace lives inside the key rather than beside it. US (0x1f) is the
 * separator because it cannot appear in a trimmed workspace id or goal text.
 */
function goalMemoryKey(goal, workspaceId) {
  return `${normalizeWorkspaceId(workspaceId)}\u001f${lower(goal)}`;
}

/**
 * Iterations spent by *this* saveRun() call.
 *
 * `state.iteration` is cumulative across resumes, so writing it into a rolling
 * window sum counts the same iterations again on every resume. Callers that
 * track a run's starting point pass `iterationsDelta`; those that do not (a
 * direct saveRun of a one-shot run, or a test seeding usage) fall back to the
 * cumulative figure, which for a non-resumed run is the same number.
 */
function resolveIterationsDelta(state = {}) {
  const explicit = Number(state.iterationsDelta);
  if (state.iterationsDelta !== null && state.iterationsDelta !== undefined
    && state.iterationsDelta !== '' && Number.isFinite(explicit)) {
    return Math.max(0, explicit);
  }
  return Math.max(0, Number(state.iteration || state.completedSteps || 0));
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

module.exports = { goalMemoryKey, lower, normalizeGoal, resolveIterationsDelta, safeParse };
