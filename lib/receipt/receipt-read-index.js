'use strict';

/**
 * V4-PR2.6 - Receipt Materialization / Read Index.
 *
 * Reads only full receipt objects already materialized into the audit/log
 * path. It never synthesizes a receipt from query state or generates a
 * replacement receiptId.
 */

const { appendReceiptToChain, validateReceiptChain } = require('./receipt-chain');
const { exportReceiptBundle } = require('./receipt-export');
const { classifyReceiptFamily, validateV4Chain } = require('./v4-receipt-family');
const {
  collectMaterializedReceiptEntries,
  listMaterializedReceiptEntries,
  receiptToCanonicalPayload,
  trimText,
} = require('./receipt-read-index-entries');
const {
  anchoredChainFailure,
  readStoredChainAnchor,
  readStoredChainAnchorFor,
  validateMaterializedAgainstStoredChain,
  validateStoredChainAgainstTip,
} = require('./receipt-read-index-anchor');

const { cloneJson: clone } = require('../json-clone');

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
      const stored = validateStoredChainAgainstTip(storedAnchor);
      if (!stored.chainStatus.valid) chainStatus = stored.chainStatus;
      else {
        const materializedMismatch = validateMaterializedAgainstStoredChain(chain, storedAnchor);
        if (materializedMismatch) chainStatus = materializedMismatch;
        else {
          chain = stored.chain;
          chainStatus = stored.chainStatus;
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
  const { chain, chainStatus } = validateStoredChainAgainstTip(storedAnchor);
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
