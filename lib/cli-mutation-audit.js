'use strict';

/**
 * The durable half of the CLI mutation audit seam.
 *
 * Kernel keeps `recordCliMutationAudit` as the only entry point the CLI may
 * call; the write itself lives here so the two kernels share one
 * implementation and neither grows to hold it.
 *
 * Every failure path returns `auditRecorded: false` rather than throwing. That
 * return value is the CLI gate's admission signal (#760): a mutation whose
 * audit could not be written is not allowed to run, so this function must be
 * able to say "no" without also taking the process down.
 */

const { validateCliMutationAuditIntent, isPlainObject } = require('./cli-mutation-audit-intent');

const AUDIT_WRITE_FAILED = 'AUDIT_WRITE_FAILED';

function failure() {
  return { auditRecorded: false, event: null, errorCode: AUDIT_WRITE_FAILED };
}

function recordCliMutationAudit(graph, intent) {
  try {
    const validated = validateCliMutationAuditIntent(intent);
    if (!validated || !graph || typeof graph.appendAuditEvent !== 'function') return failure();

    const details = {
      source: 'cli',
      command: validated.sourceCommand,
      mutationType: validated.mutationType,
      decision: validated.decision,
      executed: validated.executionEligible,
      reason: validated.reason,
      phase: validated.phase,
    };
    if (validated.approvalState !== undefined) details.approvalState = validated.approvalState;
    if (validated.receiptReference !== undefined) details.receiptId = validated.receiptReference;

    const event = graph.appendAuditEvent({
      eventType: validated.eventType,
      targetType: 'cli_mutation',
      targetId: validated.sourceCommand,
      actor: validated.actor || 'cli-user',
      workspaceId: validated.workspaceId || 'default',
      details,
    });

    // A promise here would mean the event is not durable yet, which is exactly
    // what the caller must not assume.
    if (!isPlainObject(event) || typeof event.then === 'function') return failure();
    return { auditRecorded: true, event, errorCode: null };
  } catch (_) {
    return failure();
  }
}

module.exports = { recordCliMutationAudit, AUDIT_WRITE_FAILED };
