'use strict';

/**
 * Durable chain anchor for receipt-read-index.js: reads the write-time receipt
 * chain snapshot (SQLite mutation_receipts or the JSON journal), validates it
 * against its recorded tip, and cross-checks the audit projection against it
 * (#1520).
 */

const { stableStringify } = require('./canonical-receipt');
const { validateReceiptChain } = require('./receipt-chain');
const { validateV4Chain } = require('./v4-receipt-family');
const { inferMaterializedWorkspaceId, inferReceiptFamily } = require('./receipt-read-index-entries');

const { cloneJson: clone } = require('../json-clone');

/**
 * Read the write-time chain snapshot when the source is a Graph. Array fixtures
 * and external read-index adapters deliberately have no anchor and retain the
 * legacy structural validation contract; durable Graph sources do not.
 */
function readStoredChainAnchorFor(source, workspaceId, receiptFamily) {
  const hasSqliteAnchor = Boolean(source?._db
    && source?._stmts?.getLatestMutationReceiptHash
    && typeof source._stmts.getLatestMutationReceiptHash.get === 'function');
  const hasJsonAnchor = typeof source?.readJsonJournal === 'function';
  if (!hasSqliteAnchor && !hasJsonAnchor) return null;

  if (!workspaceId) {
    return {
      available: true,
      error: 'materialized receipt workspace or family is ambiguous',
    };
  }

  try {
    const chainKey = receiptFamily ? `${workspaceId}::${receiptFamily}` : null;
    if (hasSqliteAnchor) {
      const rows = source._db.prepare(
        `SELECT receipt_id, workspace_id, receipt_family, canonical_payload,
                previous_receipt_hash, receipt_hash, committed_at
         FROM mutation_receipts
         WHERE workspace_id = ?${receiptFamily ? ' AND receipt_family = ?' : ''}
         ORDER BY sequence ASC`,
      ).all(...(receiptFamily ? [workspaceId, receiptFamily] : [workspaceId]));
      const latest = receiptFamily
        ? source._stmts.getLatestMutationReceiptHash.get(workspaceId, receiptFamily)
        : null;
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

    const journal = source.readJsonJournal();
    const storedReceipts = Object.values(journal.receipts || {})
      .filter((receipt) => receipt?.workspaceId === workspaceId
        && (!receiptFamily || receipt?.receiptFamily === receiptFamily));
    return {
      available: true,
      workspaceId,
      receiptFamily,
      expectedTip: (chainKey && journal.chainTips?.[chainKey]) || null,
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
  const workspaceId = inferMaterializedWorkspaceId(entries, filters);
  const receiptFamily = inferReceiptFamily(entries);
  // An empty projection has no family to infer, and that alone is not
  // ambiguous: the durable side decides. Counting the whole workspace instead
  // of one family keeps a genuinely empty store on the valid empty-chain path
  // (see the `expectedCount === 0` branch in receipt-read-index.js)
  // while a wiped audit trail -- durable rows, empty projection -- still fails
  // closed. A non-empty projection whose family cannot be resolved is a real
  // ambiguity and stays rejected here.
  if (!receiptFamily && entries.length > 0) {
    return {
      available: true,
      error: 'materialized receipt workspace or family is ambiguous',
    };
  }
  return readStoredChainAnchorFor(source, workspaceId, receiptFamily);
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

/**
 * Cross-check the durable chain against the audit projection (#1520).
 *
 * What this is for is the journal: a receipt that was committed must still be
 * in the audit log, unchanged and in the same order, so that deleting or
 * editing an audit event cannot go unnoticed. It is not an inventory of the
 * audit log, and the two are not the same set.
 *
 * A receipt reaches the audit log whenever a decision is recorded; it reaches
 * the journal only when that decision committed a graph mutation. Reviews that
 * changed nothing, and approval-flow decisions, are therefore audit-only by
 * design -- `collectMaterializedReceiptEntries` already drops approval receipts
 * for exactly this reason. Measured on two real stores: 140 of 201 receipt-
 * bearing audit events in one and 14,895 of 14,996 in the other were never
 * journaled, so requiring equal counts made every V4 receipt in both stores
 * unreadable and reported it as a chain-integrity failure.
 *
 * Kind is not the discriminator either, and that is why this compares
 * membership rather than filtering by `receiptKind`: in the larger store 165 of
 * those review receipts *are* journaled, because those reviews did commit. So
 * the comparison is projected onto the ids the journal claims, in materialized
 * order. Audit-only receipts are ignored -- their presence says nothing about
 * the journal. A journaled receipt missing from the projection is still a
 * failure, and still `chain_length_mismatch`: the projected list comes up
 * short, which is the tamper signal the #1520 tests assert on.
 */
function validateMaterializedAgainstStoredChain(chain, storedAnchor) {
  if (!storedAnchor?.storedReceipts) return null;
  const storedIds = new Set(storedAnchor.storedReceipts.map((stored) => stored.receiptId));
  const observed = chain.filter((record) => storedIds.has(record.receiptId));
  if (observed.length !== storedAnchor.storedReceipts.length) {
    return anchoredChainFailure(
      { valid: true, brokenAt: null, reason: null },
      'chain_length_mismatch',
      'a recorded receipt is missing from the materialized audit trail',
      {
        expectedCount: storedAnchor.storedReceipts.length,
        observedCount: observed.length,
        auditOnlyCount: chain.length - observed.length,
      },
    );
  }
  for (let index = 0; index < observed.length; index += 1) {
    const materialized = observed[index];
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

/**
 * Rebuild and validate the durable chain from the write-time snapshot, then
 * check its head against the recorded tip. Returns the chain alongside its
 * status so the caller can adopt the durable chain once it is proven.
 */
function validateStoredChainAgainstTip(storedAnchor) {
  if (!storedAnchor?.available) return { chain: [], chainStatus: null };
  if (storedAnchor.error) {
    return {
      chain: [],
      chainStatus: anchoredChainFailure(
        { valid: true, brokenAt: null, reason: null },
        'stored_chain_anchor_unavailable',
        'recorded receipt chain anchor could not be read',
        { anchorError: storedAnchor.error },
      ),
    };
  }
  const chain = materializedReceiptChainFromStored(storedAnchor);
  const chainStatus = chain.some((record) => record.schemaVersion === 'v4-receipt-v2')
    ? validateV4Chain(chain)
    : validateReceiptChain(chain);
  if (!chainStatus.valid) {
    return { chain, chainStatus: anchoredChainFailure(chainStatus, 'stored_chain_invalid', 'recorded receipt chain is invalid') };
  }
  if (!storedAnchor.expectedTip) {
    return { chain, chainStatus: anchoredChainFailure(chainStatus, 'stored_chain_tip_missing', 'recorded receipt chain has no recorded chain tip') };
  }
  if (chain.at(-1)?.receiptHash !== storedAnchor.expectedTip) {
    return {
      chain,
      chainStatus: anchoredChainFailure(chainStatus, 'chain_tip_mismatch', 'recorded receipt chain head does not match the stored chain tip', {
        expectedTip: storedAnchor.expectedTip,
        observedTip: chain.at(-1)?.receiptHash || null,
      }),
    };
  }
  return { chain, chainStatus };
}

module.exports = {
  anchoredChainFailure,
  readStoredChainAnchor,
  readStoredChainAnchorFor,
  validateMaterializedAgainstStoredChain,
  validateStoredChainAgainstTip,
};
