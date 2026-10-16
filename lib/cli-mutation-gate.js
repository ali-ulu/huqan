'use strict';

/**
 * The CLI mutation gate (F-004), and the audit write its allow decision
 * depends on (#760).
 *
 * Commands with no huqan.* MCP tool can still mutate state, so they are
 * classified here and audited before they run. The gate's promise is that
 * nothing mutates silently -- which means the audit write is part of the
 * admission decision, not a side effect of it. `recordCliMutationAudit`
 * reports failure by return value (unavailable writer, rejected intent, a
 * non-durable result), and every one of those used to be discarded, so a
 * broken audit sink failed open into unaudited `restore`/`backup`/`kaydet`.
 * An audit that cannot be written now blocks the command instead.
 *
 * Read-only commands are absent from CLI_MUTATION_GATE and return null, so
 * they stay usable when the audit sink is down: they have nothing to audit.
 */

const { normalizeCommandText } = require('./command-parser');

// Decision semantics:
//   - 'allow'  → local recovery/persistence ops that must still run
//                (test-covered) but are audited (no silent mutation).
//   - 'review' → mutations with a durable approval workflow.
//   - 'block'  → CLI surfaces that are intentionally unavailable because no
//                durable approval workflow exists for them in this release.
//   - mutationType 'none' → read-only/control aliases that are merely
//                           classified (not audited, not blocked).
const CLI_MUTATION_GATE = Object.freeze({
  kaydet:    { decision: 'allow',  reason: 'cli_persist_local',                 mutationType: 'persistence',   auditEvent: 'UPDATE' },
  backup:    { decision: 'allow',  reason: 'cli_backup_export_local',           mutationType: 'export',        auditEvent: 'EXPORTED' },
  restore:   { decision: 'allow',  reason: 'cli_restore_state_replace_local',   mutationType: 'state_replace', auditEvent: 'IMPORTED' },
  evolve:    { decision: 'block', reason: 'cli_canonical_mutation_unavailable', mutationType: 'canonical',  auditEvent: 'BLOCKED' },
  optimize:  { decision: 'block', reason: 'cli_canonical_mutation_unavailable', mutationType: 'canonical',  auditEvent: 'BLOCKED' },
  konsolide: { decision: 'block', reason: 'cli_canonical_mutation_unavailable', mutationType: 'canonical',  auditEvent: 'BLOCKED' },
  dusun:     { decision: 'block', reason: 'cli_automation_unavailable',        mutationType: 'automation',  auditEvent: 'BLOCKED' },
  ruya:      { decision: 'allow',  reason: 'cli_read_only_inference',            mutationType: 'none' },
  inference: { decision: 'allow', reason: 'cli_inference_runtime', mutationType: 'candidate_claim', auditEvent: 'UPDATE' },
  hypotheses: { decision: 'allow', reason: 'cli_hypothesis_proposal',            mutationType: 'candidate_claim', auditEvent: 'UPDATE' },
  // Distinct from `hypotheses` above even though both write a candidate claim:
  // a conflict verdict clears a read-block that a hypothesis verdict does not,
  // and a gate that could not tell them apart could not express a different
  // policy for them (#3187).
  conflicts:  { decision: 'allow', reason: 'cli_conflict_candidate_review',       mutationType: 'candidate_claim', auditEvent: 'UPDATE' },
  // Distinct from the candidate-claim entry above: applying a tuning
  // suggestion writes a threshold, not a claim, and a gate that could not tell
  // the two apart could not express a different policy for them.
  'hypotheses-tuning-apply': { decision: 'allow', reason: 'cli_hypothesis_threshold_apply', mutationType: 'hypothesis_thresholds', auditEvent: 'UPDATE' },
  // Quickstart mutates only a throwaway demo store it creates itself, never
  // canonical user memory, so it is allowed rather than review-gated. It is
  // still audited, and the canonical write it performs inside that store goes
  // through the normal axiom.learn review + axiom.approve path.
  quickstart: { decision: 'allow', reason: 'cli_quickstart_isolated_demo_store', mutationType: 'demo_sandbox', auditEvent: 'UPDATE' },
  // Reversible removal bound to a receipt (#3461). It is a local memory
  // mutation like `kaydet`, not a canonical-graph write, so it is allowed and
  // audited; the removal itself is soft (the record survives as 'deleted').
  'memory-lifecycle': { decision: 'allow', reason: 'cli_memory_lifecycle_reversible_removal', mutationType: 'memory_lifecycle', auditEvent: 'DELETE' },
  // Reflective promotion (#3550). Allowed and audited like memory-lifecycle:
  // the command runs only on the operator's explicit decision, and the loop
  // itself still refuses learner approvers and undeclared widenings.
  terfi:    { decision: 'allow', reason: 'cli_promotion_operator_driven', mutationType: 'promotion', auditEvent: 'UPDATE' },
});

const AUDIT_BLOCKED_REASON = 'cli_audit_write_failed';
const AUDIT_SINK_UNAVAILABLE = 'AUDIT_SINK_UNAVAILABLE';
const AUDIT_WRITE_FAILED = 'AUDIT_WRITE_FAILED';

/**
 * Write one CLI mutation audit event through the Kernel seam.
 *
 * @returns {{auditRecorded: boolean, errorCode: string|null}} Never throws: a
 *   thrown audit writer is a failed audit, and the caller decides what that
 *   means for the command.
 */
function auditCliMutation(kernel, { command, classification, decision, executed, phase, operatorReason, receiptReference, workspaceId } = {}) {
  try {
    // A kernel with no audit seam is an unavailable sink, not an exemption.
    if (!kernel || typeof kernel.recordCliMutationAudit !== 'function') {
      return { auditRecorded: false, errorCode: AUDIT_SINK_UNAVAILABLE, event: null };
    }
    const intent = {
      sourceCommand: command,
      mutationType: classification.mutationType,
      eventType: classification.auditEvent || (decision === 'allow' ? 'UPDATE' : 'REVIEW'),
      decision,
      executionEligible: executed,
      reason: classification.reason,
      actor: 'cli-user',
      phase: phase || 'attempted',
    };
    // The operator's own words, the mutation's receipt id, and the workspace it
    // acted on are separate from the fixed policy reason: `reason` stays the
    // classification the audit mapping matches on, while these carry the
    // accountability evidence. A workspace-scoped removal must not be audited
    // under `default`, or an audit query for that workspace misses it.
    if (operatorReason) intent.operatorReason = operatorReason;
    if (receiptReference) intent.receiptReference = receiptReference;
    if (workspaceId) intent.workspaceId = workspaceId;
    const result = kernel.recordCliMutationAudit(intent);
    if (!result || result.auditRecorded !== true) {
      return {
        auditRecorded: false,
        errorCode: (result && result.errorCode) || AUDIT_WRITE_FAILED,
        event: null,
      };
    }
    return { auditRecorded: true, errorCode: null, event: result.event || null };
  } catch (_) {
    return { auditRecorded: false, errorCode: AUDIT_WRITE_FAILED, event: null };
  }
}

function classify(command, args) {
  const normalized = normalizeCommandText(command);
  // 'düşün dur' stops the auto-think loop — a control action, not a mutation.
  if (normalized === 'dusun' && String(args || '').trim() === 'dur') {
    return { normalized, classification: { decision: 'allow', reason: 'cli_automation_stop', mutationType: 'none' } };
  }
  if (normalized === 'inference') {
    try {
      if (['history', 'query', 'abduce'].includes(JSON.parse(args).action)) return { normalized, classification: { decision: 'allow', reason: 'cli_read_only_inference', mutationType: 'none' } };
    } catch (_) { /* Invalid requests keep the mutation gate before validation. */ }
  }
  return { normalized, classification: CLI_MUTATION_GATE[normalized] };
}

/**
 * Synthetic gate decision for CLI mutation/maintenance commands that have no
 * huqan.* MCP tool. Returns null for unknown/read-only commands so they
 * proceed ungated.
 */
function evaluateCliMutationGate({ kernel, command, args } = {}) {
  const { normalized, classification } = classify(command, args);
  if (!classification) return null;

  // The operator's own reason, when the command carries one in its parsed args
  // (`memory-lifecycle --reason`). Kept separate from the fixed policy reason.
  const operatorReason = args && typeof args === 'object' && typeof args.reason === 'string'
    ? args.reason.trim()
    : '';

  const decision = classification.decision;
  const audit = classification.mutationType === 'none'
    ? { auditRecorded: true, errorCode: null }
    : auditCliMutation(kernel, {
      command: normalized,
      classification,
      decision,
      executed: decision === 'allow',
      phase: 'attempted',
      operatorReason,
      workspaceId: args && typeof args === 'object' ? args.workspaceId : undefined,
    });

  if (!audit.auditRecorded) return blockedByAudit(normalized, classification, audit);

  const canExecute = decision === 'allow';
  return {
    ok: true,
    allowed: canExecute,
    canExecute,
    canDryRun: decision === 'review',
    decision,
    reason: classification.reason,
    requiredReview: decision === 'review',
    dryRunOnly: false,
    findings: [{ gate: 'CLI', command: normalized, mutationType: classification.mutationType, decision }],
    warnings: [],
    metadata: { source: 'cli', command: normalized, mutationType: classification.mutationType, auditRecorded: true },
  };
}

/** The mutation was admissible, but its audit evidence was not. */
function blockedByAudit(command, classification, audit) {
  return {
    ok: true,
    allowed: false,
    canExecute: false,
    canDryRun: false,
    decision: 'block',
    reason: AUDIT_BLOCKED_REASON,
    requiredReview: false,
    dryRunOnly: false,
    findings: [{
      gate: 'CLI',
      command,
      mutationType: classification.mutationType,
      decision: 'block',
      auditErrorCode: audit.errorCode,
    }],
    warnings: [],
    metadata: {
      source: 'cli',
      command,
      mutationType: classification.mutationType,
      auditRecorded: false,
      auditErrorCode: audit.errorCode,
      classifiedDecision: classification.decision,
    },
  };
}

/**
 * Record that a mutation actually completed.
 *
 * The gate's event is written before the command runs, so on its own it proves
 * only admission. This is the matching `committed` event; a run with an
 * attempted event and no committed one is a mutation that did not finish.
 */
function commitCliMutation(kernel, command, explicitClassification = null, extra = {}) {
  const { normalized, classification } = explicitClassification
    ? { normalized: normalizeCommandText(command), classification: explicitClassification }
    : classify(command, '');
  if (!classification || classification.mutationType === 'none') {
    return { auditRecorded: true, errorCode: null };
  }
  return auditCliMutation(kernel, {
    command: normalized,
    classification,
    decision: classification.decision,
    executed: classification.decision === 'allow',
    phase: 'committed',
    operatorReason: extra.operatorReason,
    receiptReference: extra.receiptReference,
    workspaceId: extra.workspaceId,
  });
}

module.exports = {
  CLI_MUTATION_GATE,
  classify,
  AUDIT_BLOCKED_REASON,
  auditCliMutation,
  evaluateCliMutationGate,
  commitCliMutation,
};
