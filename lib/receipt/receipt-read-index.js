'use strict';

/**
 * V4-PR2.6 - Receipt Materialization / Read Index.
 *
 * Reads only full receipt objects already materialized into the audit/log
 * path. It never synthesizes a receipt from query state or generates a
 * replacement receiptId.
 */

const { buildCanonicalReceiptPayload, stableStringify } = require('./canonical-receipt');
const {
  buildCanonicalReceiptPayloadV2,
  classifyRawMaterializedReceipt,
} = require('./canonical-receipt-v2');
const {
  GENESIS_PREVIOUS_HASH,
  appendReceiptToChain,
  validateReceiptChain,
} = require('./receipt-chain');
const { exportReceiptBundle } = require('./receipt-export');
const {
  classifyReceiptFamily,
  validateV4Chain,
  V4_RECEIPT_ERROR_CODES,
} = require('./v4-receipt-family');
const { toCanonicalVerdict } = require('../verdict/action-verdict');

const { isPlainObject } = require('../is-plain-object');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isReceiptCandidate(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch (_) {
    return false;
  }
}

function getAuditEvents(source, filters = {}) {
  if (source && typeof source.getAuditEvents === 'function') {
    return source.getAuditEvents(filters);
  }
  if (Array.isArray(source)) {
    return source.filter((event) => {
      if (filters.workspaceId && event.workspaceId !== filters.workspaceId) return false;
      if (filters.eventType && event.eventType !== filters.eventType) return false;
      if (filters.targetType && event.targetType !== filters.targetType) return false;
      return true;
    });
  }
  return [];
}

function publicAuditRef(event = {}) {
  return {
    auditId: trimText(event.auditId),
    eventType: trimText(event.eventType),
    targetType: trimText(event.targetType),
    targetId: trimText(event.targetId),
    workspaceId: trimText(event.workspaceId) || 'default',
    timestamp: trimText(event.timestamp),
  };
}

function receiptToCanonicalPayload(receipt, knownClassification) {
  if (!isPlainObject(receipt)) {
    throw new TypeError('receiptToCanonicalPayload requires a materialized receipt object');
  }
  const verdict = toCanonicalVerdict('admission', trimText(receipt.decision));
  const classification = knownClassification || classifyRawMaterializedReceipt(receipt);
  if (classification.kind === 'legacy_v1_unspecified') {
    return buildCanonicalReceiptPayload(receipt, { verdict });
  }
  if (classification.kind === 'v2') {
    return buildCanonicalReceiptPayloadV2(receipt, { verdict, trustRoot: classification.trustRoot });
  }
  const error = new TypeError(classification.kind === 'unsupported_schema_version'
    ? 'materialized receipt declares an unsupported canonical schema version'
    : 'materialized V2 receipt requires an exact valid trustRoot');
  error.causeCode = classification.kind === 'unsupported_schema_version'
    ? V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION
    : V4_RECEIPT_ERROR_CODES.INVALID_TRUST_ROOT;
  throw error;
}

// The chain and the stamp must be built over the same order, or the head of
// one is not the head of the other. receipt-stamp.js sorts its rows by
// (timestamp, auditId); this file walked getAuditEvents in raw store order. Any
// store that does not return audit events chronologically therefore produced a
// chain whose headHash disagreed with the headHash getReceiptStamp reported --
// and receipt-validation-cache keys on (headHash, receiptCount), so the
// disagreement turns into false cache hits and misses.
function byTimestampThenAuditId(left, right) {
  const timestampOrder = String(left?.timestamp || '').localeCompare(String(right?.timestamp || ''));
  return timestampOrder || String(left?.auditId || '').localeCompare(String(right?.auditId || ''));
}

function collectMaterializedReceiptEntries(source, filters = {}) {
  const workspaceId = trimText(filters.workspaceId);
  // Sorted before the de-duplication below, not after: with two audit events
  // carrying the same receiptId, raw order would decide which one is kept.
  const events = [...getAuditEvents(source, workspaceId ? { workspaceId } : {})].sort(byTimestampThenAuditId);
  const seen = new Set();
  const entries = [];

  for (const event of events) {
    const receipt = event && event.details && event.details.receipt;
    // A malformed object still needs an INVALID_RECEIPT response when its id
    // is requested. It must not silently disappear as NOT_FOUND just because
    // the shared boundary predicate rejected an inherited or exotic record.
    if (!isReceiptCandidate(receipt)) continue;

    // Approval-flow receipts are audit records, not canonical materialized
    // receipts.  Their decision vocabulary is approved/rejected, whereas the
    // canonical receipt chain is deliberately limited to admission verdicts.
    // Including them makes a valid admission receipt chain unreadable merely
    // because a separate action audit happened later in the same workspace.
    if (receipt.receiptKind === 'reviewed_action_receipt'
      || receipt.receiptKind === 'blocked_action_receipt') continue;

    const receiptId = trimText(receipt.receiptId);
    if (!receiptId || seen.has(receiptId)) continue;
    seen.add(receiptId);
    const classification = classifyRawMaterializedReceipt(receipt);
    entries.push({
      receipt: clone(receipt),
      auditEvent: publicAuditRef(event),
      classification,
    });
  }

  return entries;
}

function listMaterializedReceiptEntries(source, filters = {}) {
  return collectMaterializedReceiptEntries(source, filters).map(({ receipt, auditEvent }) => ({
    receipt,
    auditEvent,
  }));
}

function inferMaterializedWorkspaceId(entries, filters = {}) {
  const requested = trimText(filters.workspaceId);
  if (requested) return requested;
  const workspaceIds = new Set(entries
    .map((entry) => trimText(entry.receipt?.workspaceId) || trimText(entry.auditEvent?.workspaceId))
    .filter(Boolean));
  return workspaceIds.size === 1 ? [...workspaceIds][0] : null;
}

function inferReceiptFamily(entries) {
  const families = new Set();
  for (const entry of entries) {
    try {
      families.add(classifyReceiptFamily(receiptToCanonicalPayload(entry.receipt, entry.classification)));
    } catch (_) {
      return null;
    }
  }
  return families.size === 1 ? [...families][0] : null;
}

/**
 * Read the write-time chain snapshot when the source is a Graph. Array fixtures
 * and external read-index adapters deliberately have no anchor and retain the
 * legacy structural validation contract; durable Graph sources do not.
 */
function readStoredChainAnchorFor(source, workspaceId, receiptFamily) {
  const hasSqliteAnchor = Boolean(source?._db
    && source?._stmts?.getLatestMutationReceiptHash
    && typeof source._stmts.getLatestMutationReceiptHash.get === 'function');
  const hasJsonAnchor = typeof source?._readJsonJournal === 'function';
  if (!hasSqliteAnchor && !hasJsonAnchor) return null;

  if (!workspaceId || !receiptFamily) {
    return {
      available: true,
      error: 'materialized receipt workspace or family is ambiguous',
    };
  }

  try {
    const chainKey = `${workspaceId}::${receiptFamily}`;
    if (hasSqliteAnchor) {
      const rows = source._db.prepare(
        `SELECT receipt_id, workspace_id, receipt_family, canonical_payload,
                previous_receipt_hash, receipt_hash, committed_at
         FROM mutation_receipts
         WHERE workspace_id = ? AND receipt_family = ?
         ORDER BY sequence ASC`,
      ).all(workspaceId, receiptFamily);
      const latest = source._stmts.getLatestMutationReceiptHash.get(workspaceId, receiptFamily);
      return {
        available: true,
        workspaceId,
        receiptFamily,
        expectedTip: latest?.receipt_hash || null,
        expectedCount: rows.length,
        storedReceipts: rows.map((row) => ({
          receiptId: row.receipt_id,
          workspaceId: row.workspace_id,
          receiptFamily: row.receipt_family,
          canonicalPayload: JSON.parse(row.canonical_payload),
          previousReceiptHash: row.previous_receipt_hash,
          receiptHash: row.receipt_hash,
          committedAt: row.committed_at,
        })),
      };
    }

    const journal = source._readJsonJournal();
    const storedReceipts = Object.values(journal.receipts || {})
      .filter((receipt) => receipt?.workspaceId === workspaceId && receipt?.receiptFamily === receiptFamily);
    return {
      available: true,
      workspaceId,
      receiptFamily,
      expectedTip: journal.chainTips?.[chainKey] || null,
      expectedCount: storedReceipts.length,
      storedReceipts,
    };
  } catch (error) {
    return {
      available: true,
      error: error.message || String(error),
    };
  }
}

function readStoredChainAnchor(source, entries, filters = {}) {
  return readStoredChainAnchorFor(
    source,
    inferMaterializedWorkspaceId(entries, filters),
    inferReceiptFamily(entries),
  );
}

function stripDurableReceiptMetadata(payload) {
  const normalized = clone(payload);
  delete normalized?.receiptHash;
  delete normalized?.previousReceiptHash;
  if (normalized?.metadata && typeof normalized.metadata === 'object') {
    delete normalized.metadata.mutationOperationId;
    delete normalized.metadata.committedAt;
  }
  return normalized;
}

function sameCanonicalReceipt(left, right) {
  return stableStringify(stripDurableReceiptMetadata(left))
    === stableStringify(stripDurableReceiptMetadata(right));
}

function materializedReceiptChainFromStored(storedAnchor) {
  return (storedAnchor?.storedReceipts || []).map((stored) => ({
    ...stored.canonicalPayload,
    previousReceiptHash: stored.previousReceiptHash,
    receiptHash: stored.receiptHash,
  }));
}

function validateMaterializedAgainstStoredChain(chain, storedAnchor) {
  if (!storedAnchor?.storedReceipts) return null;
  if (chain.length !== storedAnchor.storedReceipts.length) {
    return anchoredChainFailure(
      { valid: true, brokenAt: null, reason: null },
      'chain_length_mismatch',
      'materialized receipt count does not match the recorded receipt count',
      { expectedCount: storedAnchor.storedReceipts.length, observedCount: chain.length },
    );
  }
  for (let index = 0; index < chain.length; index += 1) {
    const materialized = chain[index];
    const stored = storedAnchor.storedReceipts[index];
    if (materialized.receiptId !== stored.receiptId) {
      return anchoredChainFailure(
        { valid: true, brokenAt: null, reason: null },
        'receipt_order_mismatch',
        'materialized receipt order does not match the recorded receipt chain',
        { brokenAt: index, expectedReceiptId: stored.receiptId, observedReceiptId: materialized.receiptId },
      );
    }
    if (!sameCanonicalReceipt(materialized, stored.canonicalPayload)) {
      return anchoredChainFailure(
        { valid: true, brokenAt: null, reason: null },
        'materialized_receipt_mismatch',
        'materialized receipt does not match the recorded receipt chain',
        { brokenAt: index, receiptId: materialized.receiptId },
      );
    }
  }
  return null;
}

function anchoredChainFailure(chainStatus, reason, message, details = {}) {
  return {
    ...chainStatus,
    valid: false,
    brokenAt: chainStatus.brokenAt ?? 0,
    reason,
    message,
    ...details,
  };
}

function buildMaterializedReceiptChainFromEntries(entries, storedAnchor = null) {
  let chain = [];
  let previousReceiptHash;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const payload = receiptToCanonicalPayload(entry.receipt, entry.classification);
      const chained = appendReceiptToChain(payload, previousReceiptHash);
      chain.push(chained);
      previousReceiptHash = chained.receiptHash;
    } catch (error) {
      return {
        ok: false,
        status: 'invalid',
        chain: [],
        entries,
        chainStatus: {
          valid: false,
          brokenAt: i,
          reason: 'invalid_materialized_receipt',
          message: error.message,
        },
      };
    }
  }

  let chainStatus = chain.some((record) => record.schemaVersion === 'v4-receipt-v2')
    ? validateV4Chain(chain)
    : validateReceiptChain(chain);
  if (chainStatus.valid && storedAnchor?.available) {
    if (storedAnchor.error) {
      chainStatus = anchoredChainFailure(
        chainStatus,
        'stored_chain_anchor_unavailable',
        'recorded receipt chain anchor could not be read',
        { anchorError: storedAnchor.error },
      );
    } else if (storedAnchor.expectedCount === 0 && chain.length === 0) {
      // An empty durable store has no tip by design and is a valid empty chain.
    } else {
      const storedChain = materializedReceiptChainFromStored(storedAnchor);
      const storedChainStatus = storedChain.some((record) => record.schemaVersion === 'v4-receipt-v2')
        ? validateV4Chain(storedChain)
        : validateReceiptChain(storedChain);
      if (!storedChainStatus.valid) {
        chainStatus = anchoredChainFailure(
          storedChainStatus,
          'stored_chain_invalid',
          'recorded receipt chain is invalid',
        );
      } else if (!storedAnchor.expectedTip) {
        chainStatus = anchoredChainFailure(
          storedChainStatus,
          'stored_chain_tip_missing',
          'materialized receipt chain has no recorded chain tip',
        );
      } else if (storedChain.at(-1)?.receiptHash !== storedAnchor.expectedTip) {
        chainStatus = anchoredChainFailure(
          storedChainStatus,
          'chain_tip_mismatch',
          'recorded receipt chain head does not match the stored chain tip',
          { expectedTip: storedAnchor.expectedTip, observedTip: storedChain.at(-1)?.receiptHash || null },
        );
      } else {
        const materializedMismatch = validateMaterializedAgainstStoredChain(chain, storedAnchor);
        if (materializedMismatch) chainStatus = materializedMismatch;
        else {
          chain = storedChain;
          chainStatus = storedChainStatus;
        }
      }
    }
  }
  return {
    ok: chainStatus.valid,
    status: chainStatus.valid ? 'valid' : 'invalid',
    chain,
    entries,
    chainStatus,
  };
}

function buildMaterializedReceiptChain(source, filters = {}) {
  const entries = collectMaterializedReceiptEntries(source, filters);
  return buildMaterializedReceiptChainFromEntries(
    entries,
    readStoredChainAnchor(source, entries, filters),
  );
}

function validateStoredReceiptChain(storedAnchor) {
  if (!storedAnchor?.available) return null;
  if (storedAnchor.error) {
    return {
      valid: false,
      brokenAt: 0,
      reason: 'stored_chain_anchor_unavailable',
      message: 'recorded receipt chain anchor could not be read',
      anchorError: storedAnchor.error,
    };
  }
  const chain = materializedReceiptChainFromStored(storedAnchor);
  const chainStatus = chain.some((record) => record.schemaVersion === 'v4-receipt-v2')
    ? validateV4Chain(chain)
    : validateReceiptChain(chain);
  if (!chainStatus.valid) {
    return anchoredChainFailure(chainStatus, 'stored_chain_invalid', 'recorded receipt chain is invalid');
  }
  if (!storedAnchor.expectedTip) {
    return anchoredChainFailure(chainStatus, 'stored_chain_tip_missing', 'recorded receipt chain has no recorded chain tip');
  }
  if (chain.at(-1)?.receiptHash !== storedAnchor.expectedTip) {
    return anchoredChainFailure(chainStatus, 'chain_tip_mismatch', 'recorded receipt chain head does not match the stored chain tip', {
      expectedTip: storedAnchor.expectedTip,
      observedTip: chain.at(-1)?.receiptHash || null,
    });
  }
  return chainStatus;
}

function readCommittedReceiptById(source, receiptId, filters = {}) {
  if (typeof source?.getCommittedMutationReceiptById !== 'function') return null;
  const stored = source.getCommittedMutationReceiptById(receiptId);
  if (!stored?.canonicalPayload || typeof stored.canonicalPayload !== 'object') return null;
  const receipt = clone(stored.canonicalPayload);
  // V4 admission receipts retain their audit-materialization proof: falling
  // back to the journal for them would let a missing or edited audit event
  // evade the #1520 equivalence check. Trust Evidence is a distinct non-V4
  // durable family, so it has no compatible audit projection to validate.
  if (classifyReceiptFamily(receipt) === 'v4') return null;
  const workspaceId = trimText(receipt.workspaceId);
  if (!workspaceId || (trimText(filters.workspaceId) && workspaceId !== trimText(filters.workspaceId))) return null;
  if (trimText(receipt.receiptId) !== receiptId) {
    return {
      ok: false,
      status: 'invalid',
      receiptId,
      receipt,
      error: { code: 'INVALID_RECEIPT', message: 'recorded receipt id does not match its canonical payload' },
    };
  }
  const storedAnchor = readStoredChainAnchorFor(source, workspaceId, classifyReceiptFamily(receipt));
  const chainStatus = validateStoredReceiptChain(storedAnchor);
  const chain = materializedReceiptChainFromStored(storedAnchor);
  const chainedReceipt = chain.find((record) => record.receiptId === receiptId) || null;
  const forensics = {
    receiptId,
    receipt,
    canonicalPayload: clone(receipt),
    chainedReceipt,
    auditEvent: {},
    chainValidation: chainStatus,
  };
  if (!chainStatus?.valid || !chainedReceipt) {
    return {
      ...forensics,
      ok: false,
      status: 'chain_invalid',
      authoritative: false,
      chainStatus: 'invalid',
      error: { code: 'INVALID_RECEIPT_CHAIN', message: chainStatus?.message || 'recorded receipt chain is invalid' },
    };
  }
  return { ...forensics, ok: true, status: 'found', authoritative: true, chainStatus: 'valid' };
}

function readReceiptById(source, receiptId, filters = {}) {
  const id = trimText(receiptId);
  if (!id) {
    return {
      ok: false,
      status: 'invalid_request',
      receiptId: '',
      error: {
        code: 'RECEIPT_ID_REQUIRED',
        message: 'receiptId is required and must be non-empty',
      },
    };
  }

  // A journaled receipt is already the durable source of truth.  Do not force
  // it through the audit-event projection: that projection is for admission
  // receipts and intentionally cannot represent every durable receipt family
  // (notably the Trust Evidence Ledger's non-V4 receipts).
  const committed = readCommittedReceiptById(source, id, filters);
  if (committed) return committed;

  const entries = collectMaterializedReceiptEntries(source, filters);
  const entry = entries.find((candidate) => trimText(candidate.receipt.receiptId) === id);
  if (!entry) {
    return {
      ok: false,
      status: 'not_found',
      receiptId: id,
      error: {
        code: 'NOT_FOUND',
        message: 'receipt was not found in the materialized read index',
      },
    };
  }

  let canonicalPayload;
  try {
    canonicalPayload = receiptToCanonicalPayload(entry.receipt, entry.classification);
  } catch (error) {
    return {
      ok: false,
      status: 'invalid',
      receiptId: id,
      receipt: clone(entry.receipt),
      auditEvent: entry.auditEvent,
      error: {
        code: 'INVALID_RECEIPT',
        ...(error.causeCode ? { causeCode: error.causeCode } : {}),
        message: error.message,
      },
    };
  }

  const chainResult = buildMaterializedReceiptChainFromEntries(
    entries,
    readStoredChainAnchor(source, entries, filters),
  );
  const chainedReceipt = chainResult.chain.find((record) => record.receiptId === id) || null;
  const forensics = {
    receiptId: id,
    receipt: clone(entry.receipt),
    canonicalPayload,
    chainedReceipt,
    auditEvent: entry.auditEvent,
    chainValidation: chainResult.chainStatus,
  };

  // A receipt is only as authoritative as the transcript it sits in. Returning
  // ok:true here made chain integrity advisory metadata that callers following
  // the primary ok/status contract never saw -- the viewer read `ok` and
  // rendered "Canonical receipt observed." over a broken chain (#766).
  //
  // Reading such a receipt is still useful for working out what went wrong, so
  // the payload is kept; it is the *status* that refuses to call it found. A
  // caller that wants the forensic copy has to look past ok:false to get it.
  if (!chainResult.chainStatus.valid) {
    return {
      ...forensics,
      ok: false,
      status: 'chain_invalid',
      authoritative: false,
      chainStatus: 'invalid',
      error: {
        code: 'INVALID_RECEIPT_CHAIN',
        message: chainResult.chainStatus.message
          || chainResult.chainStatus.reason
          || 'materialized receipt chain is invalid',
      },
    };
  }

  return {
    ...forensics,
    ok: true,
    status: 'found',
    authoritative: true,
    chainStatus: 'valid',
  };
}

function exportMaterializedReceiptBundle(source, opts = {}) {
  const chainResult = buildMaterializedReceiptChain(source, opts);
  if (!chainResult.ok) {
    return {
      ok: false,
      status: 'invalid',
      error: {
        code: 'INVALID_RECEIPT_CHAIN',
        message: chainResult.chainStatus.message || chainResult.chainStatus.reason || 'receipt chain is invalid',
      },
      chainStatus: chainResult.chainStatus,
    };
  }
  return {
    ok: true,
    status: 'exported',
    bundle: exportReceiptBundle(chainResult.chain, opts),
    chainStatus: chainResult.chainStatus,
  };
}

module.exports = {
  buildMaterializedReceiptChain,
  exportMaterializedReceiptBundle,
  listMaterializedReceiptEntries,
  readReceiptById,
  receiptToCanonicalPayload,
};
