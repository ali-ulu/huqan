'use strict';

/**
 * Experience lifecycle events inside one step (#3033).
 *
 * `runtime-seam.js` records what the plugin emit vocabulary can state:
 * `action_proposed` before the gates, `execution_finished`/`failure` after the
 * step. What happens between the two had no honest emit point: the gates and
 * the tool call both live in `executeAgentStep` (Core), which cannot import this
 * layer, and a new plugin event name would be a public contract change.
 *
 * The step executor now receives two injected hooks from `agent.js` instead:
 *
 * - `recordDecision` -- called once per step with the gates' actual verdict,
 *   before the tool runs when it is allowed. It becomes `policy_decided`. The
 *   action firewall and the tool policy are still two gates; the event records
 *   both verdicts and which gate blocked, rather than inventing a unified one.
 * - `runEffect` -- called only after every gate allowed the step, around the
 *   one call that performs it. `execution_started` is written immediately
 *   before the tool call, and only when the tool is actually called (a
 *   replayed or refused effect never starts). `memory_update` is written after
 *   a `learn` call that reports facts written to the graph. A `learn` that the
 *   admission gate sent to review wrote nothing, so it records nothing.
 *
 * `verification` follows a `memory_update` (#3151): the written edges are read
 * back from the graph (`./learn-read-back.js`) and judged by `./verifier.js`,
 * whose record, verdict and proofs the event carries. Only steps that wrote are
 * verified; there is nothing to read back otherwise.
 *
 * `repair_proposed` and `repair_executed` are not step events: the AgentV3 run
 * loop writes them (`./run-repair.js`), because a repair is a new step
 * with its own approval, not part of the failed one.
 *
 * Every write here is best effort for the run, as in `runtime-seam.js`: a
 * refused append never reaches the run loop.
 */

const { EVENT_TYPES, EXECUTION_STATUSES } = require('./contract');
const { assessOutcome } = require('./verifier');
const { assessLearnReadBack } = require('./learn-read-back');
const { runIdOf, stepIdentity } = require('./runtime-seam');

function eventBase(state, step, suffix) {
  const runId = runIdOf(state);
  const identity = runId ? stepIdentity(runId, step) : null;
  if (!identity) return null;
  const prefix = `${runId}:step:${identity.stepId}:${identity.attempt}`;
  return {
    identity,
    event: {
      runId,
      eventId: `${prefix}:${suffix}`,
      workspaceId: state && typeof state.workspaceId === 'string' && state.workspaceId ? state.workspaceId : 'default',
      attemptId: identity.attemptId,
      invocationId: identity.invocationId,
    },
    decidedEventId: `${prefix}:decided`,
    startedEventId: `${prefix}:started`,
    memoryEventId: `${prefix}:memory`,
  };
}

function appendSafely(journal, event) {
  if (!journal || typeof journal.append !== 'function' || !event) return null;
  try {
    return journal.append(event);
  } catch (_) {
    return null;
  }
}

function policyDecidedEvent(state, step, verdict) {
  const base = eventBase(state, step, 'decided');
  if (!base || !verdict) return null;
  return {
    ...base.event,
    type: EVENT_TYPES.POLICY_DECIDED,
    causedByEventId: base.identity.proposedEventId,
    payload: {
      stepId: base.identity.stepId,
      tool: step.tool,
      decision: verdict.decision,
      gate: verdict.gate || null,
      actionFirewall: verdict.actionFirewall || null,
      toolPolicy: verdict.toolPolicy || null,
    },
  };
}

function executionStartedEvent(state, step) {
  const base = eventBase(state, step, 'started');
  if (!base) return null;
  return {
    ...base.event,
    type: EVENT_TYPES.EXECUTION_STARTED,
    causedByEventId: base.decidedEventId,
    payload: { stepId: base.identity.stepId, tool: step.tool },
  };
}

/** Facts the learn call reports as written. A review, a rejection or a
 * zero count wrote nothing, and is not a memory update. */
function writtenFacts(step, result) {
  if (!step || step.tool !== 'learn' || !result || result.ok === false) return 0;
  const data = result.data || {};
  const admission = data.admission || null;
  if (admission && admission.graphWrite === false) return 0;
  return Number.isInteger(data.learned) && data.learned > 0 ? data.learned : 0;
}

function memoryUpdateEvent(state, step, result) {
  const learned = writtenFacts(step, result);
  if (!learned) return null;
  const base = eventBase(state, step, 'memory');
  if (!base) return null;
  const admission = result.data.admission || {};
  return {
    ...base.event,
    type: EVENT_TYPES.MEMORY_UPDATE,
    causedByEventId: base.startedEventId,
    payload: {
      stepId: base.identity.stepId,
      tool: step.tool,
      learned,
      admission: typeof admission.outcome === 'string' ? admission.outcome : null,
      receiptId: typeof admission.receiptId === 'string' ? admission.receiptId : null,
    },
  };
}

/**
 * The `verification` event for a step that wrote, or null. The verdict it
 * carries is the verifier's outcome status, so an insufficient check reads as
 * `unknown` rather than `verified`; the proofs are the ones the verdict earned.
 */
function verificationEvent(state, step, result, graph) {
  if (!writtenFacts(step, result)) return null;
  const assessment = assessLearnReadBack({ graph, step, state, result });
  if (!assessment) return null;
  const assessed = assessOutcome({ executionStatus: EXECUTION_STATUSES.COMPLETED, assessments: [assessment] });
  if (!assessed.ok) return null;
  const base = eventBase(state, step, 'verified');
  if (!base) return null;
  const proofs = assessment.proofs;
  return {
    ...base.event,
    type: EVENT_TYPES.VERIFICATION,
    causedByEventId: base.memoryEventId,
    verdict: assessed.outcomeStatus,
    outcomeStatus: assessed.outcomeStatus,
    proofs: assessed.outcomeStatus === 'failed'
      ? { failureEvidence: proofs.failureEvidence === true, permission: proofs.permission === true }
      : {
        integrity: proofs.integrity === true,
        coverage: proofs.coverage === true,
        verification: proofs.verification === true,
        provenance: proofs.provenance === true,
        permission: proofs.permission === true,
      },
    payload: { stepId: base.identity.stepId, tool: step.tool, learningEligibility: assessed.learningEligibility, record: assessed.record },
  };
}

function recordAfterCall(journal, graph, state, step, result) {
  // A verification is caused by the memory update it checks; if that was not
  // recorded, there is nothing in the journal for it to point at.
  const memory = appendSafely(journal, memoryUpdateEvent(state, step, result));
  if (memory && memory.ok !== false) {
    appendSafely(journal, verificationEvent(state, step, result, graph));
  }
}

/**
 * The two hooks `agent.js` hands the step executor. `getJournal` and
 * `getGraph` are read on every call, so a journal or graph attached after the
 * agent was built is still used.
 */
function createStepLifecycleRecorder(getJournal, getGraph) {
  const journal = () => (typeof getJournal === 'function' ? getJournal() : null);
  const graph = () => (typeof getGraph === 'function' ? getGraph() : null);
  return Object.freeze({
    recordDecision(step, state, verdict) {
      return appendSafely(journal(), policyDecidedEvent(state, step, verdict));
    },
    /** Wrap the tool call: started just before it, memory update after it. */
    wrapPerform(step, state, perform) {
      return () => {
        appendSafely(journal(), executionStartedEvent(state, step));
        const result = perform();
        if (result && typeof result.then === 'function') {
          return result.then((value) => {
            recordAfterCall(journal(), graph(), state, step, value);
            return value;
          });
        }
        recordAfterCall(journal(), graph(), state, step, result);
        return result;
      };
    },
  });
}

module.exports = Object.freeze({
  createStepLifecycleRecorder,
  policyDecidedEvent,
  executionStartedEvent,
  memoryUpdateEvent,
  verificationEvent,
});
