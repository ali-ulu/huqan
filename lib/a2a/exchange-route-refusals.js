'use strict';

// The three refusal shapes the A2A exchange route answers with, moved out of
// exchange-route.js (#2185).

const { classifyEvaluatorReason, classifyTransportRefusal } = require('./retry-classification');
const { buildFirewallReceiptMetadata } = require('./exchange-route-firewall');

function firewallRefusal(request, decision, authority, aggregation = null) {
  return Object.freeze({
    statusCode: 403,
    body: Object.freeze({
      decision: String(decision.decision || 'block'),
      reason: String(decision.reason || 'AGENT_ACTION_FIREWALL_EVALUATION_FAILED'),
      safeToRetry: true,
      receiptMetadata: buildFirewallReceiptMetadata(request, decision, authority, aggregation),
    }),
  });
}

/**
 * A refusal decided before the evaluator ran, so no reservation can exist.
 * Safe to retry is a structural fact here, not a judgement about the reason.
 */
function refusal(statusCode, reason) {
  return Object.freeze({
    statusCode,
    body: Object.freeze({ decision: 'block', reason, safeToRetry: classifyTransportRefusal() }),
  });
}

/**
 * A refusal carrying the evaluator's own reason.
 *
 * When it is not safe to retry, the caller is handed the task id instead of
 * being left with resending as its only move -- that pointer is the whole
 * reason P0-E exists, and withholding it here would leave a caller correctly
 * told "do not retry" and given nothing to do about it.
 *
 * The id is derived only from a key that was actually captured. An exchange
 * refused before the reserve call has no key and therefore no task, and
 * inventing one would point at a record that does not exist.
 */
function evaluatorRefusal(reason, replayKey, tasks) {
  const safeToRetry = classifyEvaluatorReason(reason);
  const body = { decision: 'block', reason, safeToRetry };
  if (!safeToRetry && replayKey) {
    try {
      body.taskId = tasks.taskIdForReplayKey(replayKey);
    } catch (_) {
      // A pointer this route cannot derive is simply absent. It is an aid, not
      // part of the refusal, and a broken one would be worse than none.
    }
  }
  return Object.freeze({ statusCode: 403, body: Object.freeze(body) });
}

module.exports = Object.freeze({ evaluatorRefusal, firewallRefusal, refusal });
