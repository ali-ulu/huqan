'use strict';

/**
 * Experience E5 at the runtime effect boundary (#3033, #2399).
 *
 * The agent loop checkpoints after a step, not inside it. A process that dies
 * after a step's effect landed but before the checkpoint was written resumes
 * with that step still queued, and before this module it simply ran the step
 * again. For a graph write that is the duplicated external effect the
 * operation ledger (`./reconciliation.js`) exists to prevent.
 *
 * This adapter puts the ledger around the one call that performs the effect:
 *
 * - the intent is recorded before the effect; if it cannot be recorded, the
 *   effect does not run (the ledger's `persist_failed` fails closed);
 * - a resumed step whose operation is still pending is refused as
 *   `EXPERIENCE_EFFECT_UNCERTAIN` -- the effect may or may not have happened,
 *   and this module cannot tell, so it neither retries nor reports success;
 * - a resumed step whose operation already finished returns the recorded
 *   outcome without running again;
 * - once an operator resolves an uncertain operation (`experience-reconcile`),
 *   "performed" replays as a completed step and "not performed" reopens the
 *   operation so the step runs once more under the same identity.
 *
 * Only tools that mutate are effects. Of the agent's internal tools that is
 * `learn`: `ask`, `verify`, `reason` and `compare` read, and the agent's
 * `dream` step runs the `Dream` generator, which makes no graph write (see
 * `dream.js#amplify`). A read re-run after a crash is harmless, so gating it
 * would only add two EVIDENCE writes per step and block resumes for nothing.
 *
 * The operation identity is the step attempt the Experience seam already
 * uses (`runtime-seam.js#stepIdentity`), so the ledger row and the journal's
 * `action_proposed`/`failure` events name the same attempt. A retry after a
 * known failure is a new attempt and therefore a new operation; only the
 * attempt that was in flight at the crash is uncertain.
 *
 * With no ledger, no run identity or no step id the effect runs as before:
 * that is the pre-wiring state, not an error, exactly like the journal seam.
 */

const crypto = require('node:crypto');
const { STATES, NOT_PERFORMED } = require('./reconciliation');
const { runIdOf, stepIdentity } = require('./runtime-seam');

const EFFECT_TOOLS = Object.freeze(['learn']);

const CODES = Object.freeze({
  UNCERTAIN: 'EXPERIENCE_EFFECT_UNCERTAIN',
  INTENT_UNRECORDED: 'EXPERIENCE_INTENT_UNRECORDED',
  OPERATION_CONFLICT: 'EXPERIENCE_OPERATION_CONFLICT',
  REPLAYED_FAILURE: 'EXPERIENCE_EFFECT_FAILED',
});

function inputHashOf(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input === undefined ? null : input);
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function blockedResult(code, message, operation) {
  return {
    ok: false, type: 'agent', data: null, evidence: [],
    error: { code, message },
    meta: { blocked: true, experienceOperation: operation },
  };
}

/** What the ledger keeps of a result: enough to replay the verdict, never the
 * payload, so one large result cannot grow the EVIDENCE table without bound. */
function outcomeOf(result) {
  const ok = !(result && result.ok === false);
  const code = !ok && result && result.error && typeof result.error.code === 'string' ? result.error.code : null;
  return { ok, code };
}

function replayedResult(operationId, claimed) {
  const outcome = claimed.outcome && typeof claimed.outcome === 'object' ? claimed.outcome : { ok: claimed.state === STATES.COMPLETED };
  const operation = { operationId, state: claimed.state, replayed: true };
  if (outcome.ok) return { ok: true, type: 'agent', data: null, evidence: [], error: null, meta: { experienceOperation: operation } };
  return {
    ok: false, type: 'agent', data: null, evidence: [],
    error: { code: outcome.code || CODES.REPLAYED_FAILURE, message: 'This step already ran and failed; the recorded outcome is returned instead of running it again.' },
    meta: { experienceOperation: operation },
  };
}

function refusalFor(begun, operation) {
  if (begun.code === 'operation_conflict') {
    return blockedResult(CODES.OPERATION_CONFLICT, 'This step attempt is already recorded with a different intent.', operation);
  }
  return blockedResult(CODES.INTENT_UNRECORDED, 'The step intent could not be recorded, so the step was not run.', operation);
}

/** Record the outcome. A failed record leaves the operation pending, which a
 * later resume reports as uncertain -- the fail-closed direction. */
function recordOutcome(ledger, operationId, result) {
  const outcome = outcomeOf(result);
  ledger.complete({ operationId, outcome, failed: !outcome.ok });
}

function recordThrown(ledger, operationId, error) {
  const code = error && typeof error.code === 'string' ? error.code : 'THROWN';
  ledger.complete({ operationId, outcome: { ok: false, code }, failed: true });
}

/**
 * Run `perform` for `step` behind the operation ledger. Returns the tool
 * result, a replayed result, or a blocked refusal; never throws on its own.
 */
function runStepEffect({ ledger, state, step, perform }) {
  if (!ledger || typeof ledger.begin !== 'function' || !step || !EFFECT_TOOLS.includes(step.tool)) return perform();
  const runId = runIdOf(state);
  const identity = runId ? stepIdentity(runId, step) : null;
  if (!identity) return perform();
  const operationId = `${identity.attemptId}:effect`;
  const operation = { operationId, state: STATES.PENDING, replayed: false };
  const begun = ledger.begin({
    operationId,
    runId,
    workspaceId: state.workspaceId,
    intent: { tool: step.tool, stepId: identity.stepId, attempt: identity.attempt, inputSha256: inputHashOf(step.input) },
  });
  if (!begun.ok) return refusalFor(begun, operation);
  if (begun.duplicate) {
    if (begun.state === STATES.PENDING) {
      return blockedResult(CODES.UNCERTAIN, 'This step was in flight when the run stopped and its outcome is unknown; it was not run again. Check whether the effect landed and record it with `experience-reconcile <operationId> --performed|--not-performed --reason <text>` before resuming.', { ...operation, reconciliation: 'unknown', retry: false });
    }
    const claimed = ledger.claim(operationId);
    if (!isVerifiedNotPerformed(claimed)) return replayedResult(operationId, claimed);
    if (!ledger.reopen(operationId).ok) return refusalFor({ code: 'persist_failed' }, operation);
  }
  return performAndRecord(ledger, operationId, perform);
}

/** The operator checked the outside world and the effect never landed, so
 * running it now is the first effect, not a duplicate. */
function isVerifiedNotPerformed(claimed) {
  return claimed && claimed.state === STATES.FAILED && claimed.outcome && claimed.outcome.code === NOT_PERFORMED;
}

function performAndRecord(ledger, operationId, perform) {
  let result;
  try {
    result = perform();
  } catch (error) {
    recordThrown(ledger, operationId, error);
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => { recordOutcome(ledger, operationId, value); return value; },
      (error) => { recordThrown(ledger, operationId, error); throw error; },
    );
  }
  recordOutcome(ledger, operationId, result);
  return result;
}

/**
 * The operation a step report was refused on as uncertain, or null. The run
 * loop uses it to keep the step queued and the run resumable: an uncertain
 * effect is neither a finished step nor a block, because a blocked run drops
 * its checkpoint and the verdict an operator records would have nothing left
 * to resume.
 */
function uncertainOperationOf(report) {
  const result = report && report.result;
  if (!result || !result.error || result.error.code !== CODES.UNCERTAIN) return null;
  return (result.meta && result.meta.experienceOperation) || null;
}

module.exports = Object.freeze({ runStepEffect, uncertainOperationOf, EFFECT_TOOLS, CODES });
