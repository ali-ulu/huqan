'use strict';

// Applying a break-glass window to one guard decision (İP-2).
//
// The one rule this module exists to enforce, stated as code rather than as
// documentation: **a window may only relax a review into an allow.** It runs
// after every other gate has merged, and it returns the incoming decision
// unchanged unless that decision is exactly `review`. A `block` is never
// touched -- a deploy, a force-push, a destructive delete and a secret write
// stay refused while a window is open. That is the whole safety argument: the
// window shortens the queue in front of a human, it does not remove the human
// from the actions that matter.
//
// The module is deliberately pure with respect to the guard: it takes the
// decision and a ledger and returns a new decision plus a finding, so it can be
// tested against the real ledger without standing up the whole guard, and the
// guard's own path only has to call it in one place.
//
// Every successful application is recorded through `ledger.consume`, so a
// window's use count and its audit trail cannot diverge: an allow that a window
// produced is a ledger entry, not a footnote.

const { EXTERNAL_ACTION_DECISIONS, EXTERNAL_ACTION_REASONS } = require('./external-action-guard-rules');

/**
 * @param {object} input
 * @param {string} input.decision the merged decision the guard reached
 * @param {{riskCategory?: string, workspaceId?: string}} input.envelope
 * @param {{ledger?: object, windowId?: string, actor?: string}} [input.breakGlass]
 * @returns {{decision: string, applied: boolean, finding?: object, consumed?: object, refusal?: string}}
 */
function applyBreakGlass({ decision, envelope = {}, breakGlass } = {}) {
  const unchanged = (refusal) => ({ decision, applied: false, ...(refusal ? { refusal } : {}) });
  // The only decision a window can move. Checked first so a block is refused
  // before the ledger is even read.
  if (decision !== EXTERNAL_ACTION_DECISIONS.REVIEW) return unchanged();
  if (!breakGlass || !breakGlass.ledger || !breakGlass.windowId) return unchanged('break_glass_not_configured');

  const decisionOnWindow = breakGlass.ledger.check({
    windowId: breakGlass.windowId,
    workspaceId: envelope.workspaceId,
    agentId: envelope.identity?.identityRef,
    category: envelope.riskCategory,
  });
  if (!decisionOnWindow.active) return unchanged(decisionOnWindow.refusal);

  const consumed = breakGlass.ledger.consume({
    windowId: breakGlass.windowId,
    workspaceId: envelope.workspaceId,
    agentId: envelope.identity?.identityRef,
    category: envelope.riskCategory,
    actor: breakGlass.actor,
    reason: decisionOnWindow.window.reason,
  });
  // A window that verified a moment ago and then failed to record its use is
  // not a window this call may spend: the audit trail would be missing the very
  // use it authorised. Hold the review.
  if (!consumed || !consumed.consumed) return unchanged(consumed?.reason || 'break_glass_consume_failed');

  return {
    decision: EXTERNAL_ACTION_DECISIONS.ALLOW,
    applied: true,
    consumed,
    finding: {
      gate: 'break-glass',
      decision: EXTERNAL_ACTION_DECISIONS.ALLOW,
      reason: EXTERNAL_ACTION_REASONS.BREAK_GLASS,
      windowId: decisionOnWindow.window.windowId,
      breakGlassReason: decisionOnWindow.window.reason,
      breakGlassActor: decisionOnWindow.window.actor,
      expiresAt: decisionOnWindow.window.expiresAt,
      remainingUses: consumed.remainingUses,
    },
  };
}

module.exports = { applyBreakGlass };
