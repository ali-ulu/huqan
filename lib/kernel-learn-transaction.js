'use strict';

const { normalizeWorkspaceId } = require('./cli-mutation-audit-intent');
const { ProvenanceError } = require('./errors/provenance-error');

/**
 * The synchronous learn path: durable-mutation journal, critical section,
 * canonical receipt projection, persistence fan-out and post-commit effects.
 *
 * Moved verbatim from Kernel.learn (#2127). It takes the critical section
 * itself, so it is concurrency-guarded on its own; learnAsync() wraps it
 * for the preIngest pass, not for safety (#368).
 *
 * #216 (gap 4): every call goes through the durable mutation journal, not
 * just callers that explicitly pass mutationOperationId. A caller-supplied
 * id is used as-is; otherwise one is generated internally.
 *
 * Collaborators arrive as an explicit object so this module never reaches
 * into kernel internals. `kernel` itself is passed through to the
 * admit/runUseCase seams only -- this module never touches kernel
 * private members (asserted by test and by check-module-boundary). Wiring
 * those seams to injected callbacks keeps the transaction unit-testable
 * without a live kernel. buildCanonicalReceipt is injected for the same
 * reason in the other direction: the receipt/verdict modules live in the
 * Application layer, and a direct require from this Core module would be
 * a new layer violation, so the projection stays at the call site.
 */
function runLearnTransaction(collaborators, text, opts = {}) {
  const {
    graph,
    kernel,
    enterCriticalSection,
    exitCriticalSection,
    appendAuditEvent,
    admit,
    runUseCase,
    buildCanonicalReceipt,
  } = collaborators;
  const { text: nextText, opts: nextOpts } = admit(kernel, text, opts);
  enterCriticalSection('learn');
  try {
    const operationId = typeof nextOpts.mutationOperationId === 'string' && nextOpts.mutationOperationId.trim()
      ? nextOpts.mutationOperationId.trim()
      : `auto-mut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!graph || typeof graph.runMutationOnce !== 'function') {
      const error = new Error('durable mutation journal is unavailable');
      error.code = 'DURABLE_MUTATION_JOURNAL_UNAVAILABLE';
      throw error;
    }
    const postCommitEffects = [];
    const runMutationOnceOpts = {
      buildCanonicalReceipt: (learnResult) => {
        const receipt = learnResult?.data?.admission?.receipt;
        // Bypass-mode and admission-free learns produce no admission
        // receipt at all -- that is expected (not every learn goes
        // through the admission gate), so this mutation simply commits
        // without a canonical receipt rather than failing the write.
        if (!receipt || typeof receipt !== 'object') return null;
        const committedAt = new Date().toISOString();
        return buildCanonicalReceipt(receipt, operationId, committedAt);
      },
    };
    let outcome;
    try {
      outcome = graph.runMutationOnce(operationId, () => runUseCase(kernel, nextText, {
        ...nextOpts,
        _durableMutationTransaction: true,
        _postCommitEffects: postCommitEffects,
      }, {
        normalizeWorkspaceId,
        ProvenanceError,
      }), runMutationOnceOpts);
    } catch (error) {
      // A strictProvenance rejection is an expected, final outcome (not a
      // mid-transaction crash), and learn-use-case.js already appends a
      // REJECT audit event for it before throwing -- but runMutationOnce's
      // rollback-on-error restores in-memory state to the pre-mutation
      // snapshot, which undoes that in-memory audit append along with
      // everything else (correctly so for a genuine crash, where nothing
      // should be left behind). Re-append it here so the rejection itself
      // stays on the audit trail, matching the admission-reject path
      // (which returns normally instead of throwing and is therefore
      // unaffected by rollback).
      if (error instanceof ProvenanceError || error?.code === 'PROVENANCE_REQUIRED') {
        appendAuditEvent({
          eventType: 'REJECT',
          targetType: 'learn',
          targetId: nextText,
          details: { reason: error.code || 'PROVENANCE_REQUIRED', message: error.message, text: nextText },
        }, nextOpts.provenance && typeof nextOpts.provenance === 'object' ? nextOpts.provenance : null, normalizeWorkspaceId(nextOpts.workspaceId));
      }
      throw error;
    }
    const result = outcome.result;
    if (result && typeof result === 'object') {
      result.meta = {
        ...(result.meta || {}),
        durableMutation: true,
        replayed: outcome.replayed === true,
        committedReceiptId: outcome.receipt?.receiptId || null,
        committedReceiptHash: outcome.receipt?.receiptHash || null,
      };
    }
    if (!outcome.replayed) {
      // The JSON backend's runMutationOnce already calls save() itself
      // while committing (outcome.persisted === true); only the SQLite
      // path still needs this call here, to sync its JSON fallback export
      // (SQLite's own persistence is the DB transaction, already done).
      if (!outcome.persisted) {
        try { graph.save(); } catch (error) { console.error('[Kernel] Graph save error:', error.message); }
      }
      for (const effect of postCommitEffects) {
        try { effect(); } catch (error) { console.error('[Kernel] post-commit effect error:', error.message); }
      }
    }
    return result;
  } finally {
    exitCriticalSection();
  }
}

module.exports = { runLearnTransaction };
