'use strict';

const { buildLearnAdmissionRequest } = require('./learn-admission-request');
const { evaluateMemoryAdmission } = require('./memory-admission-gate');
const { emitGateTelemetry } = require('./gate-telemetry');

/**
 * Decide whether a learn may write to the graph.
 *
 * Taken out of `Kernel._evaluateLearnAdmission` to make room in kernel.js,
 * which sat exactly on its recorded ceiling, for the named context
 * VerifyService now receives instead of the whole kernel.
 *
 * Chosen over the cross-link derivation, which is the other block of this
 * size: several ADR-012 contract tests count audit call sites by reading
 * kernel.js as text, and moving an `_appendAuditEvent` site out from under
 * them would have meant rewriting six of those measurements to chase the
 * code. This block contains no audit write, so the counts stay put.
 *
 * A failed evaluation is not an open door: it returns a `review` outcome, and
 * `kernel.js` writes only when the outcome is `allow`, so an unreadable
 * verdict blocks the write rather than defaulting to permitting it. That
 * branch had no test -- flipping it to `allow` passed the whole suite -- which
 * is why `evaluate` is injectable here: a fail-closed rule nobody can make
 * fail is a rule nobody has checked.
 */
function evaluateLearnAdmission(deps, text, opts = {}, provenance = null, workspaceId = 'default') {
  const { kernel, isLearnAdmissionBypass, contractVersion, evaluate = evaluateMemoryAdmission } = deps;

  if (isLearnAdmissionBypass(opts)) return null;

  const request = buildLearnAdmissionRequest({
    text, opts, provenance, workspaceId, contractVersion,
  });

  const evaluated = evaluate(request, {
    approvalRequired: request.approvalRequired,
  });
  if (!evaluated || !evaluated.ok || !evaluated.decision) {
    emitGateTelemetry(kernel, 'memory-admission', {
      decision: 'review', reason: 'memory_admission_evaluation_failed',
    });
    return {
      outcome: 'review',
      reason: 'memory_admission_evaluation_failed',
      graphWrite: false,
      workspaceId,
    };
  }

  emitGateTelemetry(kernel, 'memory-admission', evaluated.decision);

  return {
    outcome: evaluated.decision.decision,
    reason: evaluated.decision.reason,
    graphWrite: evaluated.decision.allowed,
    workspaceId,
    approvalStatus: evaluated.decision.approvalStatus,
    provenanceId: evaluated.decision.provenanceId,
    receiptId: evaluated.decision.receiptId,
    receipt: evaluated.decision.receipt,
    trustPolicyVersion: evaluated.decision.trustPolicyVersion,
  };
}

module.exports = { evaluateLearnAdmission };
