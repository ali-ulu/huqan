'use strict';

/**
 * Experience Core E3 — the runtime seam adapter (#2378).
 *
 * The one place a live agent run writes an Experience event. Both agent
 * runtimes share `Agent._emit` as their lifecycle hub, so the call site here
 * decides *that* a lifecycle event happened and `lib/experience/` decides what
 * it means. No domain logic lives here.
 *
 * Only the two boundaries that are unambiguous without a policy decision are
 * recorded today: `beforeAgentRun` opens the Experience, `afterAgentRun` closes
 * it. The middle of the run (`action_proposed`, `policy_decided`,
 * `execution_*`, `verification`) needs the adapter-reporting and verifier
 * deliveries from the epic, and is deliberately not invented here.
 *
 * A journal is optional. A run with no journal configured is not an error --
 * it is the pre-wiring state every existing caller is in -- so this never
 * throws into the run loop.
 */

const { EVENT_TYPES, EXECUTION_STATUSES } = require('./contract');

/** The Experience identity for a live run. Stamped once so the close event
 * reuses the same runId the open event wrote. */
function runIdOf(state) {
  if (!state || typeof state !== 'object') return null;
  for (const field of ['runId', 'observabilityRunId']) {
    if (typeof state[field] === 'string' && state[field]) return state[field];
  }
  return null;
}

function workspaceIdOf(state) {
  return state && typeof state.workspaceId === 'string' && state.workspaceId
    ? state.workspaceId
    : 'default';
}

/** Derived from the run outcome, never inferred from the goal. A run that did
 * not reach a terminal status (paused on a time budget, for example) is left
 * without an executionStatus on purpose: it is not a completed execution. */
function executionStatusOf(status) {
  if (status === 'completed') return EXECUTION_STATUSES.COMPLETED;
  if (status === 'blocked') return EXECUTION_STATUSES.FAILED;
  return undefined;
}

/**
 * Project one lifecycle signal into the journal. Called from `Agent._emit`,
 * which is best-effort for its other consumers (observability, plugins); a
 * journal refusal must not escalate into the run loop, so the result is
 * returned for a caller that wants it but never thrown.
 */
function emitRunLifecycle(event, data, journal) {
  if (!journal || typeof journal.append !== 'function') return null;
  if (!data || typeof data !== 'object') return null;
  const runId = runIdOf(data);
  if (!runId) return null;
  const workspaceId = workspaceIdOf(data);

  if (event === 'beforeAgentRun') {
    // Stamp the identity onto the state so the matching close reuses it even
    // when the caller only ever supplied an observability id.
    if (!data.runId) data.runId = runId;
    return journal.append({
      runId,
      eventId: `${runId}:run_started`,
      type: EVENT_TYPES.RUN_STARTED,
      workspaceId,
      payload: {
        goal: data.goal,
        agentId: data.agentId,
        resumed: data.resumed === true,
      },
    });
  }

  if (event === 'afterAgentRun') {
    const executionStatus = executionStatusOf(data.status);
    // A run that did not reach a terminal status (paused on a time budget) is
    // left open on purpose: the acceptance contract distinguishes a run that
    // finished from one that merely stopped, and a premature run_closed would
    // make a half-done run look complete after a restart.
    if (!executionStatus) return null;
    return journal.append({
      runId,
      eventId: `${runId}:run_closed`,
      type: EVENT_TYPES.RUN_CLOSED,
      workspaceId,
      executionStatus,
      payload: {
        status: data.status,
        finalAnswer: data.finalAnswer,
        iterationsDelta: Number.isFinite(data.iterationsDelta) ? data.iterationsDelta : 0,
      },
    });
  }

  return null;
}

module.exports = { emitRunLifecycle, runIdOf };
