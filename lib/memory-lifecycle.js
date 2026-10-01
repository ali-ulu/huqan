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
}

module.exports = {
  MEMORY_LIFECYCLE_POLICY_VERSION,
  MemoryLifecycle,
  toRecordProvenance,
  toRecallRecord,
  computeReverificationHorizon,
  applyReverificationHorizon,
};
