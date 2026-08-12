'use strict';

const { appendAuditEvent, AUDIT_EVENTS } = require('../audit-log');

function recordPreflightAudit(target, result, action, options = {}) {
  if (!target) return { ok: true, recorded: false, event: null };
  try {
    const event = appendAuditEvent(target, {
      eventType: AUDIT_EVENTS.QUERY,
      targetType: 'error-prevention-preflight',
      targetId: result.receipt?.receiptId || '',
      workspaceId: action.workspaceId || 'default',
      actor: options.actor || 'error-prevention',
      details: {
        decision: result.decision,
        preventionDecision: result.preventionDecision,
        upstreamVerdict: result.upstreamVerdict,
        reasonCodes: result.reasonCodes,
        matchedRuleIds: result.matchedRules.map((rule) => rule.ruleId),
        matchedFailureIds: result.matchedRules.map((rule) => rule.sourceFailureId),
        matchedEvidenceRefs: result.matchedEvidenceRefs,
        receiptId: result.receipt?.receiptId || '',
      },
    }, { provenance: options.provenance });
    return { ok: true, recorded: true, event };
  } catch (error) {
    return {
      ok: false,
      recorded: false,
      event: null,
      error: { code: 'ERROR_PREVENTION_AUDIT_FAILED', message: error?.message || String(error) },
    };
  }
}

module.exports = { recordPreflightAudit };
