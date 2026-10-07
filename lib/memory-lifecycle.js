'use strict';

/**
 * MemoryLifecycle (#3036) — the single caller that composes the six shipped
 * memory modules into one write → read → score → verify flow.
 *
 * The six modules each already ship with tests and a production caller of
 * their own:
 *   - admission gate    lib/memory-admission-gate.js            write-side verdict
 *   - admission horizon lib/admission-horizon.js                derived reverification
 *   - recall gate       lib/memory-recall-gate.js               read-side verdict
 *   - receipt chain     lib/receipt/receipt-chain.js            tamper-evident link
 *   - trust score       lib/trust-score-aggregator.js           workspace metric
 *   - crypto adapter    lib/receipt/cryptographic-verification-adapter.js
 *
 * What was missing is the seam between them, and the seam is real: the
 * admission gate reads a *flat* `provenanceId`
 * (lib/memory-admission-gate.js:24) while the recall gate reads a *nested*
 * `record.provenance.provenanceId` (lib/memory-recall-gate.js:108) -- the
 * shape lib/memory-schema-checks.js:55 requires of a stored record. A record
 * admitted through the gate therefore reads back as `missing_provenance`
 * unless something bridges the two shapes. `toRecallRecord` is that bridge.
 *
 * This module holds no state of its own beyond the chain tip it threads, opens
 * no ledger, and delegates every decision to the module that owns it: the
 * admission gate still decides admission, the recall gate still decides recall,
 * the chain primitive still decides tamper-evidence. It never writes
 * `ledgerEvents` -- it returns them for the caller to append through the
 * existing audit path, exactly as lib/memory-recall-gate.js requires.
 *
 * ## Why the receipt collaborators are injected, not required
 *
 * This module lives in the Adapters ring (`lib/memory-` is the persistence
 * family, scripts/architecture-dependency-graph.js), while lib/receipt/* is
 * Application. A direct `require('./receipt/receipt-chain')` is an upward
 * Adapters -> Application edge and fails the layer gate, which asks for the
 * collaborator to be passed in instead. So `chain` and `crypto` arrive as
 * constructor options; a UI entrypoint -- the only ring allowed to reach
 * Application -- supplies them. The composition is unchanged; only the wiring
 * site moves to where the layer policy puts it.
 */

const { isPlainObject } = require('./is-plain-object');
const { evaluateMemoryAdmission } = require('./memory-admission-gate');
const { computeReverificationHorizon, applyReverificationHorizon } = require('./admission-horizon');
const { evaluateMemoryRecall } = require('./memory-recall-gate');
const { computeTrustScore } = require('./trust-score-aggregator');
const { selectConsolidationCandidates } = require('./memory-consolidation');

const MEMORY_LIFECYCLE_POLICY_VERSION = 'huqan-memory-lifecycle-v0.1.0';

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = trimText(value);
    if (text) return text;
  }
  return '';
}

/**
 * Bridge a flat admission request onto the nested provenance object a stored
 * memory record must carry (lib/memory-schema-checks.js:55). A caller that
 * already supplies a nested `provenance` keeps every field it set; only the
 * fields it omitted are filled from the flat request, so a declared
 * confidence or expiry is never overwritten.
 */
function toRecordProvenance(request = {}, existing = null) {
  const base = isPlainObject(existing) ? existing : {};
  const workspaceId = firstNonEmpty(base.workspaceId, request.workspaceId) || 'default';
  const defaults = {
    provenanceId: firstNonEmpty(request.provenanceId) || `prov_${workspaceId}`,
    sourceRef: firstNonEmpty(request.sourceRef) || 'memory-lifecycle',
    sourceTitle: firstNonEmpty(request.sourceTitle) || 'Memory Lifecycle',
    sourceType: firstNonEmpty(request.sourceType) || 'memory-lifecycle',
    actor: firstNonEmpty(request.actor) || 'kernel',
    timestamp: firstNonEmpty(request.createdAt) || new Date().toISOString(),
    workspaceId,
    trustPolicyVersion: firstNonEmpty(request.trustPolicyVersion) || '1.0.0',
    confidence: Number.isFinite(Number(request.declaredConfidence)) ? Number(request.declaredConfidence) : 1,
  };
  const merged = { ...defaults, ...base };
  // provenanceId must never be dropped: an explicit nested id wins, else the
  // flat request's, and only then the derived default.
  merged.provenanceId = firstNonEmpty(base.provenanceId, request.provenanceId) || defaults.provenanceId;
  return merged;
}

/**
 * Project an admission result onto the record shape the recall gate reads: a
 * stored memory record with a nested `provenance` object. This is the missing
 * bridge between the two gates. Fields already present on `record` win, so a
 * caller may pass the real stored record and have only the gaps filled.
 */
function toRecallRecord(admission, record = {}) {
  const decision = isPlainObject(admission && admission.decision) ? admission.decision : {};
  const proposed = isPlainObject(decision.proposedMemory) ? decision.proposedMemory : {};
  const request = isPlainObject(decision.request) ? decision.request : {};
  const receipt = isPlainObject(admission && admission.receipt) ? admission.receipt : {};
  const receiptMetadata = isPlainObject(receipt.metadata) ? receipt.metadata : {};
  const base = isPlainObject(record) ? record : {};
  const workspaceId = firstNonEmpty(base.workspaceId, decision.workspaceId, request.workspaceId) || 'default';

  return {
    ...base,
    memoryId: firstNonEmpty(base.memoryId, proposed.memoryId, decision.memoryDraftId, decision.admissionId),
    workspaceId,
    status: firstNonEmpty(base.status) || 'active',
    content: base.content !== undefined ? base.content : proposed.content,
    trustPolicyVersion: firstNonEmpty(base.trustPolicyVersion, decision.trustPolicyVersion, request.trustPolicyVersion),
    provenance: toRecordProvenance(request, base.provenance),
    metadata: {
      ...(isPlainObject(base.metadata) ? base.metadata : {}),
      admissionId: firstNonEmpty(decision.admissionId),
      receiptId: firstNonEmpty(receipt.receiptId),
      ...(receiptMetadata.reverificationHorizon ? { reverificationHorizon: receiptMetadata.reverificationHorizon } : {}),
      ...(receiptMetadata.expiresAt ? { expiresAt: receiptMetadata.expiresAt } : {}),
    },
  };
}

/** The canonical payload a chained admission receipt commits to. */
function receiptChainPayload(receipt = {}) {
  return {
    receiptId: trimText(receipt.receiptId),
    admissionId: trimText(receipt.admissionId),
    workspaceId: trimText(receipt.workspaceId),
    decision: trimText(receipt.decision),
    memoryDraftId: trimText(receipt.memoryDraftId),
    createdAt: trimText(receipt.createdAt),
  };
}

/** The canonical payload a chained tombstone/supersede receipt commits to. */
function lifecycleReceiptPayload(receipt = {}) {
  return {
    receiptId: trimText(receipt.receiptId),
    action: trimText(receipt.action),
    memoryId: trimText(receipt.memoryId),
    newMemoryId: trimText(receipt.newMemoryId),
    workspaceId: trimText(receipt.workspaceId),
    actor: trimText(receipt.actor),
    // `reason` and `eventId` are hashed too: both are part of what the receipt
    // asserts, so a tampered reason or swapped event id must break the chain,
    // exactly as a changed action would.
    reason: trimText(receipt.reason),
    eventId: trimText(receipt.eventId),
    createdAt: trimText(receipt.createdAt),
  };
}

class MemoryLifecycle {
  constructor(kernel, options = {}) {
    this.kernel = kernel;
    this.options = isPlainObject(options) ? options : {};
    // Application-ring collaborators, injected by a UI entrypoint (see the
    // layer note above). `chain` is the receipt-chain primitive
    // ({ GENESIS_PREVIOUS_HASH, appendReceiptToChain, validateReceiptChain });
    // `crypto` is the cryptographic-verification adapter
    // ({ verifyCryptographicEvidence }).
    this.chain = this.options.chain || null;
    this.crypto = this.options.crypto || null;
    // The chain tip this caller threads forward: the `previousReceiptHash` for
    // the next write (the chain primitive does not mutate or store it).
    this.chainTip = null;
  }

  /**
   * Write path: admission verdict → derived horizon (already applied onto the
   * receipt by lib/memory-admission-gate-receipt.js) → chained receipt.
   *
   * Returns the admission result augmented with `record` (recall-gate ready)
   * and `chainedReceipt`. A `review`/`quarantine`/`reject` verdict is a
   * decision, not an error: it is returned, not thrown, and the caller reads
   * `decision.decision`.
   */
  admit(writeRequest = {}) {
    const admission = evaluateMemoryAdmission(writeRequest, this.options.admissionOptions);
    if (!admission.ok || !admission.decision) {
      return { ...admission, record: null, chainedReceipt: null };
    }
    const record = toRecallRecord(admission, writeRequest.record);
    const chainedReceipt = this._chainReceipt(admission.receipt);
    return { ...admission, record, chainedReceipt };
  }

  _chainReceipt(receipt) {
    if (!isPlainObject(receipt) || !this.chain) return null;
    const chained = this.chain.appendReceiptToChain(
      receiptChainPayload(receipt),
      this.chainTip || this.chain.GENESIS_PREVIOUS_HASH,
    );
    this.chainTip = chained.receiptHash;
    return chained;
  }

  /**
   * Read path: run the recall gate over stored records. `ledgerEvents` are
   * returned for the caller to append through the existing audit path; this
   * module never writes them.
   */
  recall(queryResult = {}, context = {}) {
    const records = Array.isArray(queryResult)
      ? queryResult
      : (Array.isArray(queryResult.records) ? queryResult.records : []);
    return evaluateMemoryRecall({
      workspaceId: firstNonEmpty(context.workspaceId, queryResult.workspaceId),
      records,
      currentTrustPolicyVersion: firstNonEmpty(context.currentTrustPolicyVersion, this.options.currentTrustPolicyVersion),
      minConfidence: context.minConfidence,
      observedAt: context.observedAt,
    });
  }

  /** Workspace trust score, delegated to lib/trust-score-aggregator.js. */
  score(workspaceId, options = {}) {
    return computeTrustScore({
      graph: this.kernel,
      workspaceId: firstNonEmpty(workspaceId) || 'default',
      ...(isPlainObject(options) ? options : {}),
    });
  }

  /** Tamper-evidence over a chain this lifecycle (or any caller) produced. */
  verifyChain(chainedReceipts, options = {}) {
    if (!this.chain) return { valid: false, brokenAt: null, reason: 'chain_collaborator_unavailable' };
    return this.chain.validateReceiptChain(chainedReceipts, options);
  }

  /** Cryptographic verification, delegated to the injected receipt crypto adapter. */
  verifyCryptographicEvidence(input) {
    if (!this.crypto) return { cryptographicState: 'unavailable' };
    return this.crypto.verifyCryptographicEvidence(input);
  }

  /**
   * Resolve the store this lifecycle acts on. A MemoryStore is passed in (the
   * CLI hands over `kernel.memory`) rather than required, because lib/memory-*
   * is the persistence family: this module may know the store's method shape,
   * never a concrete store module. The duck-typed check is deliberately narrow
   * -- `tombstone` and `supersede` are the two methods the lifecycle calls.
   */
  _memoryStore() {
    const store = this.options.memoryStore || (this.kernel && this.kernel.memory) || null;
    if (!store || typeof store.tombstone !== 'function' || typeof store.supersede !== 'function') return null;
    return store;
  }

  /**
   * Chain a lifecycle receipt, threading `previousReceiptHash` from the last
   * receipt this instance produced (admission or lifecycle). Returns null when
   * no chain collaborator was injected, so a caller without one still gets the
   * store result -- the receipt is the audit binding, not a prerequisite for
   * the reversible mutation itself.
   */
  _chainLifecycleReceipt(receipt) {
    if (!isPlainObject(receipt) || !this.chain) return null;
    const chained = this.chain.appendReceiptToChain(
      lifecycleReceiptPayload(receipt),
      this.chainTip || this.chain.GENESIS_PREVIOUS_HASH,
    );
    this.chainTip = chained.receiptHash;
    return chained;
  }

  /**
   * Tombstone (soft delete) a stored memory through the shipped store primitive,
   * binding the mutation to a chained receipt. Reversible: the record and its
   * events survive (status 'deleted'), so the read surfaces can still reach it
   * with `includeTombstoned`. Fail-closed: a refused store result is returned
   * unchanged and produces no receipt, so a mutation that did not happen can
   * never be receipted as if it had.
   */
  tombstone(memoryId, opts = {}) {
    const store = this._memoryStore();
    if (!store) return { ok: false, error: { code: 'STORE_UNAVAILABLE', message: 'memory store is not available to the lifecycle' } };
    const result = store.tombstone(memoryId, opts);
    if (!result || result.ok !== true) return result;
    return { ...result, receipt: this._buildLifecycleReceipt('tombstone', result.memory, opts, null, result.event) };
  }

  /**
   * Supersede a stored memory through the shipped store primitive, binding the
   * mutation to a chained receipt. Reversible: content is never overwritten --
   * the old record is marked 'superseded' and a `supersedes` link records the
   * chain. Fail-closed exactly as `tombstone` is.
   */
  supersede(oldMemoryId, newContent, opts = {}) {
    const store = this._memoryStore();
    if (!store) return { ok: false, error: { code: 'STORE_UNAVAILABLE', message: 'memory store is not available to the lifecycle' } };
    const result = store.supersede(oldMemoryId, newContent, opts);
    if (!result || result.ok !== true) return result;
    return { ...result, receipt: this._buildLifecycleReceipt('supersede', result.oldMemory, opts, result.newMemory, result.event) };
  }

  /**
   * Resolve the store for the archive/consolidate paths. Same duck-typed rule
   * as `_memoryStore`, keyed on the archive pair the lifecycle actually calls.
   */
  _archiveStore() {
    const store = this.options.memoryStore || (this.kernel && this.kernel.memory) || null;
    if (!store || typeof store.archive !== 'function' || typeof store.restore !== 'function') return null;
    return store;
  }

  /**
   * Archive (offload) a stored memory through the shipped store primitive,
   * binding the reversible mutation to a chained receipt. Unlike tombstone this
   * is not a removal: the record leaves the default read set but stays fully
   * restorable, so a consolidation is always undoable. Fail-closed: a refused
   * store result is returned unchanged and produces no receipt.
   */
  archive(memoryId, opts = {}) {
    const store = this._archiveStore();
    if (!store) return { ok: false, error: { code: 'STORE_UNAVAILABLE', message: 'memory store has no archive primitive' } };
    const result = store.archive(memoryId, opts);
    if (!result || result.ok !== true) return result;
    return { ...result, receipt: this._buildLifecycleReceipt('archive', result.memory, opts, null, result.event) };
  }

  /**
   * Restore an archived memory to 'active'. The inverse of `archive`; fail-closed
   * exactly as `archive` is.
   */
  restore(memoryId, opts = {}) {
    const store = this._archiveStore();
    if (!store) return { ok: false, error: { code: 'STORE_UNAVAILABLE', message: 'memory store has no archive primitive' } };
    const result = store.restore(memoryId, opts);
    if (!result || result.ok !== true) return result;
    return { ...result, receipt: this._buildLifecycleReceipt('restore', result.memory, opts, null, result.event) };
  }

  /**
   * Consolidate a workspace: select a bounded set of archive candidates and
   * offload each through `archive`, so every accepted offload is reversible and
   * receipted. Dry-run by default -- `opts.dryRun === false` is required to
   * mutate, so an accidental call cannot move records. Per-candidate refusals
   * are collected, never thrown, and the whole run is capped (see
   * lib/memory-consolidation.js) so it can never offload an unbounded slice.
   */
  consolidate(opts = {}) {
    const store = this._archiveStore();
    if (!store) return { ok: false, error: { code: 'STORE_UNAVAILABLE', message: 'memory store has no archive primitive' } };
    const selection = selectConsolidationCandidates({ list: (o) => store.list(o) }, opts);
    if (selection.ok !== true) return selection;
    const dryRun = opts.dryRun !== false;
    // Carry the selected candidates: a dry run must name which records --apply will offload.
    const result = { ok: true, dryRun, scanned: selection.scanned, total: selection.total, candidates: selection.candidates, archived: [], refused: [] };
    if (dryRun) return result;
    for (const candidate of selection.candidates) {
      const archived = this.archive(candidate.memoryId, {
        workspaceId: opts.workspaceId,
        actor: opts.actor,
        reason: opts.reason || candidate.reason,
      });
      if (archived.ok === true) result.archived.push({ memoryId: candidate.memoryId, receiptId: archived.receipt && archived.receipt.receiptId });
      else result.refused.push({ memoryId: candidate.memoryId, error: archived.error });
    }
    return result;
  }

  _buildLifecycleReceipt(action, memory, opts, newMemory, event) {
    const workspaceId = firstNonEmpty(memory && memory.workspaceId, opts.workspaceId) || 'default';
    const actor = firstNonEmpty(opts.actor, memory && memory.provenance && memory.provenance.actor) || 'memory-lifecycle';
    // The store event id makes each accepted mutation's receipt unique: without
    // it a repeated tombstone of the same memory would produce the same id and
    // the receipts would be ambiguous in an audit or lookup.
    const eventId = firstNonEmpty(event && event.eventId);
    const payload = {
      receiptId: `mlr_${action}_${firstNonEmpty(memory && memory.memoryId) || 'unknown'}${eventId ? `_${eventId}` : ''}`,
      action,
      memoryId: firstNonEmpty(memory && memory.memoryId),
      newMemoryId: firstNonEmpty(newMemory && newMemory.memoryId),
      workspaceId,
      actor,
      createdAt: new Date().toISOString(),
      // The operator's accountability for the removal. Carried on the receipt
      // (which the chain hashes) as well as the CLI audit record.
      reason: firstNonEmpty(opts.reason),
      eventId,
    };
    return {
      ...payload,
      policyVersion: MEMORY_LIFECYCLE_POLICY_VERSION,
      chainedReceipt: this._chainLifecycleReceipt(payload),
    };
  }
}

module.exports = {
  MEMORY_LIFECYCLE_POLICY_VERSION,
  MemoryLifecycle,
  toRecordProvenance,
  toRecallRecord,
  computeReverificationHorizon,
  applyReverificationHorizon,
};
