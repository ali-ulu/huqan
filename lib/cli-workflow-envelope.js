'use strict';

// Workflow output shaping for runCliArgv (#2283). Extracted from
// lib/cli-workflow-adapter.js so that module stays a dispatcher: this unit
// owns exit codes, status derivation and the JSON/text envelopes, and
// nothing else.
const { workflowEnvelope } = require('./http/workflow-envelope');
const { WORKFLOW_STATUSES } = require('./workflow-contract');

// The one exit-code table. It is keyed by *outcome*, never by output format:
// the same rejection used to leave 1 in plain text and 8 under --json, so a
// script's meaning changed with a display flag (#1995).
//
// The no-argument path is deliberately not routed through here. In plain text
// it opens the REPL -- a successful start, not invalid input -- while --json
// has no REPL to open and reports INVALID_INPUT. Those are different outcomes,
// so giving them one code would make the interactive launch report an error.
const CLI_EXIT_CODES = Object.freeze({
  completed: 0,
  invalid_input: 2,
  capability_not_available: 3,
  unauthorized: 4,
  queued: 5,
  review_required: 5,
  blocked: 6,
  paused: 7,
  partial: 7,
  failed: 8,
});

function statusFromResult(result) {
  const candidate = result?.status || result?.data?.status;
  if (WORKFLOW_STATUSES.includes(candidate)) return candidate;
  if (candidate === 'review') return 'review_required';
  if (candidate === 'refused') return 'blocked';
  if (candidate === 'needs_human_decision') return 'review_required';
  return result && typeof result === 'object' && result.ok === false ? 'failed' : 'completed';
}

function cliEnvelope(workflowId, result, status = statusFromResult(result), error = null) {
  const payload = result?.data ?? result;
  const boundedMeta = {};
  const identity = result?.meta?.identity ?? error?.meta?.identity;
  const oversight = result?.meta?.oversight ?? error?.meta?.oversight;
  if (identity && typeof identity === 'object') boundedMeta.identity = identity;
  if (oversight && typeof oversight === 'object') boundedMeta.oversight = oversight;
  const base = workflowEnvelope({
    ok: status === 'completed',
    status,
    data: error ? null : (payload && typeof payload === 'object' ? payload : { output: payload }),
    error,
    evidence: result?.evidence,
    confidence: result?.confidence ?? result?.data?.confidence,
    receiptId: result?.receiptId ?? result?.data?.receiptId ?? result?.data?.receipt?.receiptId,
  });
  return {
    ...base,
    workflowId,
    approval: result?.approval ?? result?.data?.approval ?? null,
    ...(Object.keys(boundedMeta).length > 0 ? { meta: boundedMeta } : {}),
    trace: {
      traceId: base.traceId,
      runId: result?.data?.runId ?? result?.runId ?? null,
      checkpointId: result?.data?.checkpointId ?? result?.checkpointId ?? null,
      resumeToken: result?.data?.resumeToken ?? result?.resumeToken ?? null,
      resumed: result?.data?.resumed === true || result?.resumed === true,
      resumedFrom: result?.data?.resumedFrom ?? result?.resumedFrom ?? null,
      nextAction: result?.data?.nextAction ?? result?.nextAction ?? null,
    },
  };
}

function jsonError(workflowId, status, code, message, meta = null) {
  return cliEnvelope(workflowId, null, status, {
    code,
    message,
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  });
}

module.exports = { CLI_EXIT_CODES, statusFromResult, cliEnvelope, jsonError };
