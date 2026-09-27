'use strict';

/**
 * HUQAN Coder — Experience pilot reporter (#2388).
 *
 * The agent step executor has no `replace_text` handler: its internal tools
 * are exactly learn/ask/verify/reason/compare/dream (`toolPolicy.js`
 * INTERNAL_TOOLS, `lib/agent-step-executor.js` INTERNAL_TOOL_HANDLERS), so a
 * `replace_text` pilot can never run through the agent path — it would end
 * as UNSUPPORTED_TOOL. The thing that actually executes it is
 * `applyDerivation` in `./apply-derivation.js`
 * (read declared inputs -> runTask -> evaluateCodeChange -> write).
 *
 * This module is the Experience side of that pipeline and nothing else: one
 * append per stage, same runId throughout, each event caused by the previous
 * one. It holds no filesystem handle, opens no store, and never throws into
 * the pipeline — an append refusal is returned, never raised, following the
 * runtime seam rule (`lib/experience/runtime-seam.js`).
 *
 * Chain (only stages that genuinely happened are written; nothing is
 * invented for a stage the pipeline never reached):
 *
 *   run_started (pilot manifest) -> action_proposed -> policy_decided
 *   -> execution_started -> execution_finished (patch evidence)
 *   -> verification (disk re-read + hash compare) -> run_closed (verdict)
 *
 * Refusal paths close with `failure` + `run_closed` (FAILED) instead, so a
 * refused run is distinguishable from a completed one and never looks
 * complete after the fact.
 */

const nodeCrypto = require('node:crypto');

const {
  EVENT_TYPES,
  EXECUTION_STATUSES,
  OUTCOME_STATUSES,
} = require('../experience/contract');
const { declareAdapterScope, coverageProof } = require('../experience/adapter-scope');

// Per-event byte ceiling follow-up (#2375): free text is bounded, content is
// proven by hash. Full find/replace bodies never enter a payload.
const MAX_TEXT_CHARS = 200;

function sha256(value) {
  return nodeCrypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function boundedText(value) {
  if (typeof value !== 'string') return undefined;
  return value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}…` : value;
}

function hasJournal(journal) {
  return journal && typeof journal.append === 'function';
}

/**
 * The pilot's required adapter set (#2388: "pilotun gerekli adapter kümesi
 * açıkça tanımlansın"). A coder run touches the filesystem and nothing else:
 * no browser, terminal, network, memory, A2A or external outcome adapter is
 * installed, so those classes are `unsupported` by declaration — recorded,
 * never inferred, and no event is fabricated for them.
 */
const CODER_PILOT_SCOPE = Object.freeze({
  installed: Object.freeze(['filesystem']),
  active: Object.freeze(['filesystem']),
  required: Object.freeze(['filesystem']),
});

/**
 * Create the reporter for one derivation. Returns null when no journal was
 * supplied — the caller then runs exactly as before (pre-wiring state).
 */
function createCoderReporter(journal, { runId, workspaceId = 'default', task, adapterScope } = {}) {
  if (!hasJournal(journal)) return null;
  if (!runId || typeof runId !== 'string') throw new TypeError('createCoderReporter requires a runId string');
  const declared = declareAdapterScope(adapterScope || CODER_PILOT_SCOPE);
  if (!declared.ok) throw new TypeError(`createCoderReporter requires a valid adapter scope: ${declared.code}`);
  const scope = declared.scope;
  const operation = task && task.operation ? task.operation : {};
  const operationType = typeof operation.type === 'string' ? operation.type : '';
  const attemptId = `${runId}:attempt:1`;
  const invocationId = `${runId}:invocation:${task && task.id ? task.id : 'task'}`;
  const ids = {
    runStarted: `${runId}:run_started`,
    proposed: `${runId}:action_proposed`,
    decided: `${runId}:policy_decided`,
    execStarted: `${runId}:execution_started`,
    execFinished: `${runId}:execution_finished`,
    verification: `${runId}:verification`,
    failure: `${runId}:failure`,
    closed: `${runId}:run_closed`,
  };
  const state = { failed: null, events: [] };

  function put(event) {
    let result;
    try {
      result = journal.append(event);
    } catch {
      result = { ok: false, code: 'append_threw' };
    }
    if (!result || result.ok !== true) {
      const code = result && result.code ? String(result.code) : 'append_failed';
      if (!state.failed) state.failed = code;
      return { ok: false, code };
    }
    state.events.push(event.eventId);
    return { ok: true, sequence: result.sequence };
  }

  function base(type, eventId, extra = {}) {
    return {
      runId, eventId, type, workspaceId,
      attemptId, invocationId,
      ...extra,
    };
  }

  /**
   * Observation coverage for the observed classes. A class the pilot never
   * installed is `unsupported` by the declaration above — no event is ever
   * fabricated for it, and an unmeasured effect stays `unknown`, never
   * "absent".
   */
  function coverageFor(observed) {
    const proof = coverageProof(scope, Array.isArray(observed) ? observed : []);
    return {
      covered: proof.coverage === true,
      missingRequired: [...proof.report.missingRequired],
      unknown: [...proof.report.unknown],
    };
  }

  return {
    runId,
    get failed() { return state.failed; },
    get events() { return [...state.events]; },

    started(manifest) {
      return put(base(EVENT_TYPES.RUN_STARTED, ids.runStarted, {
        payload: {
          pilot: 'coder-replace_text',
          taskId: task && task.id ? task.id : null,
          operationType,
          allowedPaths: Array.isArray(task && task.allowedPaths) ? task.allowedPaths : [],
          workspaceId,
          adapterScope: scope,
          ...manifest,
        },
      }));
    },

    proposed() {
      return put(base(EVENT_TYPES.ACTION_PROPOSED, ids.proposed, {
        causedByEventId: ids.runStarted,
        payload: {
          operationType,
          path: typeof operation.path === 'string' ? operation.path : null,
          findSha256: typeof operation.find === 'string' ? sha256(operation.find) : null,
          findChars: typeof operation.find === 'string' ? operation.find.length : null,
          replaceSha256: typeof operation.replace === 'string' ? sha256(operation.replace) : null,
          replaceChars: typeof operation.replace === 'string' ? operation.replace.length : null,
        },
      }));
    },

    decided(gate) {
      return put(base(EVENT_TYPES.POLICY_DECIDED, ids.decided, {
        causedByEventId: ids.proposed,
        payload: {
          decision: gate && gate.decision ? String(gate.decision) : null,
          reason: gate && gate.reason ? boundedText(String(gate.reason)) : null,
        },
      }));
    },

    executionStarted() {
      return put(base(EVENT_TYPES.EXECUTION_STARTED, ids.execStarted, {
        causedByEventId: ids.decided,
      }));
    },

    executionFinished({ changes, derivationHash }) {
      return put(base(EVENT_TYPES.EXECUTION_FINISHED, ids.execFinished, {
        causedByEventId: ids.execStarted,
        executionStatus: EXECUTION_STATUSES.COMPLETED,
        payload: {
          changes: Array.isArray(changes) ? changes.map((change) => ({
            path: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            afterSha256: typeof change.after === 'string' ? sha256(change.after) : null,
          })) : [],
          derivationHash: derivationHash || null,
        },
      }));
    },

    verified({ verified: allVerified, checks }) {
      return put(base(EVENT_TYPES.VERIFICATION, ids.verification, {
        causedByEventId: ids.execFinished,
        outcomeStatus: allVerified ? OUTCOME_STATUSES.VERIFIED : OUTCOME_STATUSES.FAILED,
        payload: {
          verified: allVerified === true,
          checks: Array.isArray(checks) ? checks : [],
        },
      }));
    },

    failedRefusal({ reason, detail, causeEventId }) {
      const coverage = coverageFor([]);
      const failed = put(base(EVENT_TYPES.FAILURE, ids.failure, {
        causedByEventId: causeEventId || ids.proposed,
        payload: {
          reason: reason || null,
          detail: detail ? boundedText(String(detail)) : null,
        },
      }));
      const closed = put(base(EVENT_TYPES.RUN_CLOSED, ids.closed, {
        causedByEventId: ids.failure,
        executionStatus: EXECUTION_STATUSES.FAILED,
        outcomeStatus: OUTCOME_STATUSES.FAILED,
        payload: { verdict: 'incomplete', reason: reason || null, coverage },
      }));
      return { failed, closed };
    },

    closed({ executionStatus, outcomeStatus, verdict, causeEventId, observed }) {
      const resolvedExecution = executionStatus
        || (outcomeStatus === OUTCOME_STATUSES.VERIFIED
          ? EXECUTION_STATUSES.COMPLETED
          : EXECUTION_STATUSES.FAILED);
      const coverage = coverageFor(observed);
      // The verdict is derived, never declared: `complete` needs both the
      // disk proof (verified) and the observation proof (covered). An
      // explicit verdict (dry_run) passes through untouched.
      const resolvedVerdict = verdict || (outcomeStatus === OUTCOME_STATUSES.VERIFIED && coverage.covered
        ? 'complete'
        : 'incomplete');
      return put(base(EVENT_TYPES.RUN_CLOSED, ids.closed, {
        causedByEventId: causeEventId || ids.verification,
        executionStatus: resolvedExecution,
        outcomeStatus,
        payload: { verdict: resolvedVerdict, coverage },
      }));
    },
  };
}

/**
 * Derive the runId for a derivation. The createdAt timestamp is part of it so
 * two runs of the same task never collide on `run_started` idempotency —
 * a rerun is a new run, not a duplicate event.
 */
function coderRunId(task, createdAt) {
  const taskId = task && task.id ? String(task.id) : 'task';
  return `coder:${taskId}:${String(createdAt || '')}`;
}

module.exports = {
  CODER_PILOT_SCOPE,
  createCoderReporter,
  coderRunId,
  sha256,
};
