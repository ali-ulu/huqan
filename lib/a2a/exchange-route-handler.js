'use strict';

// One A2A exchange request, from the socket deadline to the decision: the
// body checks, the bounded-exchange evaluation with its firewall admission and
// task-recording effect, and the delegation audit row. Moved out of
// exchange-route.js (#2185); the boundary there builds it once per deployment.

const { evaluateInterAgentReceiptAdmission } = require('./inter-agent-receipt-chain');
const { REQUEST_TIMEOUT_MS } = require('./agent-card');
const { A2A_ROUTE_ERRORS, CANONICAL_WORKSPACE, MAX_BODY_BYTES } = require('./exchange-route-contract');
const { buildFirewallReceiptMetadata, evaluateA2aAgentActionFirewall } = require('./exchange-route-firewall');
const { evaluatorRefusal, firewallRefusal, refusal } = require('./exchange-route-refusals');

function createA2aExchangeHandler({
  authority, replay, tasks, evaluateBoundedExchange, evaluateAgentActionFirewall, recordDelegation,
}) {
  return handle;

  async function handle(req, readBody) {
    if (String(req.method || '').toUpperCase() !== 'POST') {
      return refusal(405, A2A_ROUTE_ERRORS.METHOD);
    }

    // Bound the read before it starts. A caller that stalls mid-body holds a
    // connection open otherwise, and the deadline has to be enforced rather
    // than only declared in the Agent Card.
    if (typeof req.setTimeout === 'function') req.setTimeout(REQUEST_TIMEOUT_MS);

    let read;
    try {
      read = await readBody(req, { maxBytes: MAX_BODY_BYTES });
    } catch (_) {
      return refusal(400, A2A_ROUTE_ERRORS.BODY);
    }
    // Body-level refusals keep their own status (413 for oversize, 415 for a
    // wrong content type) but never their own body shape: every response from
    // this route is a decision/reason pair.
    if (!read || read.ok !== true) {
      return refusal(Number(read && read.status) || 400, A2A_ROUTE_ERRORS.BODY);
    }
    const body = read.data;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return refusal(400, A2A_ROUTE_ERRORS.BODY);
    }

    // The envelope carries its own workspaceId and the evaluator binds it to
    // the identity records. This check is the route's separate promise that
    // P0-B serves the canonical workspace only, so a non-default exchange is
    // refused before any verification work happens.
    if (body.workspaceId !== undefined && body.workspaceId !== CANONICAL_WORKSPACE) {
      return refusal(400, A2A_ROUTE_ERRORS.WORKSPACE);
    }

    // The evaluator computes the replay key itself and calls `effect()` with
    // no arguments, so the key is captured on its way into the reservation
    // rather than recomputed here. Recomputing would mean a second copy of
    // `replayKeyMaterial`, and a task id derived from a key that had drifted
    // from the real one would point at nothing.
    //
    // It is declared out here, rather than inside the try, because a refusal
    // needs it too: a caller told not to retry has to be told where to look
    // instead (P0-E), and that pointer is only derivable from this key.
    let replayKey = '';
    let firewallDecision = null;
    let receiptAggregation = null;
    let result;
    try {
      result = evaluateBoundedExchange({
        request: body,
        authority,
        evaluationTime: authority.evaluationTime,
        replayReserve: (record) => {
          replayKey = String(record && record.replayKey) || '';
          return replay.reserve(record);
        },
        admission: (verifiedRequest) => {
          firewallDecision = evaluateA2aAgentActionFirewall(
            verifiedRequest,
            authority,
            evaluateAgentActionFirewall,
          );
          const receiptAdmission = evaluateInterAgentReceiptAdmission(
            verifiedRequest,
            firewallDecision,
          );
          firewallDecision = receiptAdmission.decision;
          receiptAggregation = receiptAdmission.aggregation;
          return firewallDecision;
        },
        // P0-B admits an exchange; it performs no product mutation. The effect
        // still has to run inside the evaluator so that the replay reservation
        // and the admission stay one decision rather than two.
        //
        // P0-E writes the task record here, inside the effect, for the same
        // reason: if the record cannot be written the exchange is not accounted
        // for, and an unaccounted exchange must read as unknown rather than as
        // a success. A throw here leaves the reservation standing, which is
        // exactly the `effect_failure_keeps_replay_marker` behaviour.
        effect: () => {
          const admitted = Object.freeze({
            admitted: true,
            exchangeId: String(body.exchangeId || ''),
            evaluatedAt: authority.evaluationTime,
            taskId: tasks.taskIdForReplayKey(replayKey),
            receiptMetadata: buildFirewallReceiptMetadata(
              body,
              firewallDecision,
              authority,
              receiptAggregation,
            ),
          });
          tasks.recordCompletion(replayKey, admitted);
          return admitted;
        },
      });
    } catch (_) {
      // The evaluator is written not to throw, and its own catch returns
      // verification_failed. This is the belt to that braces: an unexpected
      // throw must not become a 500 that a caller can distinguish from a
      // refusal.
      recordDelegation(body, 'block', 'verification_failed');
      return evaluatorRefusal('verification_failed', replayKey, tasks);
    }

    if (!result || result.decision !== 'allow') {
      if (result && result.firewall) {
        recordDelegation(body, result.firewall.decision, result.firewall.reason);
        return firewallRefusal(body, result.firewall, authority, receiptAggregation);
      }
      const reason = (result && result.reason) || 'verification_failed';
      recordDelegation(body, 'block', reason);
      return evaluatorRefusal(reason, replayKey, tasks);
    }
    recordDelegation(body, 'allow', result.reason, result.effect && result.effect.taskId);
    return Object.freeze({
      statusCode: 200,
      body: Object.freeze({
        decision: 'allow',
        reason: result.reason,
        effect: result.effect,
      }),
    });
  }
}

module.exports = Object.freeze({ createA2aExchangeHandler });
