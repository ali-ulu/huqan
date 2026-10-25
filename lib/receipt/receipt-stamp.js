'use strict';

const { GENESIS_PREVIOUS_HASH } = require('./receipt-chain');
const { classifyRawMaterializedReceipt } = require('./canonical-receipt-v2');
const { normalizeWorkspaceId } = require('../graph-record-utils');
const { stableStringify, hashCanonicalPayload, sha256Hex } = require('../hash-chain');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SQLITE_STAMP_STATEMENTS = new WeakMap();
const SQLITE_FAMILY_STATEMENTS = new WeakMap();
const SQLITE_CHAIN_STATEMENTS = new WeakMap();

/**
 * A content-sensitive fingerprint of the durable receipt chain (#4233).
 *
 * `generation`, `receiptCount` and the stored `receipt_hash` head are all
 * write-time columns: editing a receipt's `canonical_payload` in place leaves
 * every one of them unchanged, so a stamp built from them alone stays identical
 * across a tamper and the validation cache serves its stale `valid` verdict.
 *
 * This digest recomputes each member's hash from its own payload and folds the
 * ordered (receiptId, recomputedHash, storedHash) triples together. An in-place
 * edit of either the payload or the stored hash moves it, which is what forces
 * the cache to revalidate.
 */
function chainDigestFromMembers(members) {
  const ordered = members
    .map((member) => [String(member.receiptId), member.receiptHash, String(member.storedHash)])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return sha256Hex(stableStringify(ordered));
}

/**
 * Narrow journal reader for the JSON stamp path (#2352). Graph owns the
 * journal path and the fail-closed read, so Graph passes a bound reader in
 * instead of this module reaching into `graph._readJsonJournal()`.
 */
function readJournalSnapshot(graph, opts = {}) {
  if (opts?.journal !== undefined) return opts.journal;
  if (typeof opts?.readJsonJournal === 'function') return opts.readJsonJournal();
  if (typeof graph?.readJsonJournal === 'function') return graph.readJsonJournal();
  throw new TypeError('receipt-stamp requires a journal snapshot or a graph with readJsonJournal()');
}

function rawReceiptFamily(receipt) {
  const kind = classifyRawMaterializedReceipt(receipt).kind;
  return kind === 'legacy_v1_unspecified' || kind === 'v2' ? 'v4' : null;
}

function getReceiptFamilyById(graph, receiptId, workspaceId, opts = {}) {
  if (typeof receiptId !== 'string' || !receiptId) return null;
  if (graph._db && graph._stmts) {
    let statement = SQLITE_FAMILY_STATEMENTS.get(graph);
    if (!statement) {
      statement = graph._db.prepare(`
        SELECT details
        FROM audit_log
        WHERE json_extract(details, '$.receipt.receiptId') = ?
          AND (? = '' OR workspace_id = ?)
        ORDER BY timestamp ASC, audit_id ASC
        LIMIT 1
      `);
      SQLITE_FAMILY_STATEMENTS.set(graph, statement);
    }
    const workspace = workspaceId ? normalizeWorkspaceId(workspaceId) : '';
    const row = statement.get(receiptId, workspace, workspace);
    try {
      const receipt = row ? JSON.parse(row.details)?.receipt : null;
      const family = rawReceiptFamily(receipt);
      if (family) return family;
    } catch (_) {}
    const committed = graph._stmts.getMutationReceiptById.get(receiptId);
    return committed?.receipt_family || null;
  }

  const events = Array.isArray(graph._auditEvents)
    ? graph._auditEvents
    : typeof graph.getAuditEvents === 'function' ? graph.getAuditEvents({}) : [];
  const workspace = workspaceId ? normalizeWorkspaceId(workspaceId) : '';
  for (const event of events) {
    if (workspace && normalizeWorkspaceId(event?.workspaceId) !== workspace) continue;
    const receipt = event?.details?.receipt;
    if (receipt?.receiptId !== receiptId) continue;
    const family = rawReceiptFamily(receipt);
    if (family) return family;
  }

  const journal = readJournalSnapshot(graph, opts);
  const operationId = journal.receiptsById[receiptId];
  return operationId ? journal.receipts[operationId]?.receiptFamily || null : null;
}

function sqliteStampStatement(graph) {
  let statement = SQLITE_STAMP_STATEMENTS.get(graph);
  if (!statement) {
    statement = graph._db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM mutation_journal) AS generation,
        COUNT(*) AS receipt_count,
        (
          SELECT receipt_hash
          FROM mutation_receipts
          WHERE workspace_id = ?
            AND receipt_family = ?
          ORDER BY sequence DESC
          LIMIT 1
        ) AS head_hash
      FROM mutation_receipts
      WHERE workspace_id = ?
        AND receipt_family = ?
    `);
    SQLITE_STAMP_STATEMENTS.set(graph, statement);
  }
  return statement;
}

function sqliteChainStatement(graph) {
  let statement = SQLITE_CHAIN_STATEMENTS.get(graph);
  if (!statement) {
    statement = graph._db.prepare(`
      SELECT receipt_id, canonical_payload, previous_receipt_hash, receipt_hash
      FROM mutation_receipts
      WHERE workspace_id = ?
        AND receipt_family = ?
    `);
    SQLITE_CHAIN_STATEMENTS.set(graph, statement);
  }
  return statement;
}

/**
 * Recompute each durable member's hash from its own payload (#4233). A member
 * whose payload was edited in place recomputes to a different hash, which moves
 * the digest; the stored `receipt_hash` column would not.
 */
function chainDigestFromSqliteRows(rows) {
  return chainDigestFromMembers(rows.map((row) => {
    let receiptHash;
    try {
      receiptHash = hashCanonicalPayload({ ...JSON.parse(row.canonical_payload), previousReceiptHash: row.previous_receipt_hash });
    } catch (_) {
      receiptHash = `unparseable:${String(row.canonical_payload)}`;
    }
    return { receiptId: row.receipt_id, receiptHash, storedHash: row.receipt_hash };
  }));
}

function chainDigestFromJournal(receipts) {
  return chainDigestFromMembers(receipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    receiptHash: hashCanonicalPayload({ ...receipt.canonicalPayload, previousReceiptHash: receipt.previousReceiptHash }),
    storedHash: receipt.receiptHash,
  })));
}

function getReceiptStamp(graph, workspaceId = 'default', schemaFamily, opts = {}) {
  const workspace = normalizeWorkspaceId(workspaceId);
  if (schemaFamily !== 'v4') return null;

  if (graph._db && graph._stmts) {
    try {
      const row = sqliteStampStatement(graph).get(workspace, schemaFamily, workspace, schemaFamily);
      const generation = Number(row?.generation) || 0;
      const receiptCount = Number(row?.receipt_count) || 0;
      if (!receiptCount) return { generation, receiptCount: 0, headHash: GENESIS_PREVIOUS_HASH, chainDigest: chainDigestFromMembers([]) };
      if (!HASH_PATTERN.test(row?.head_hash || '')) return null;
      const chainDigest = chainDigestFromSqliteRows(sqliteChainStatement(graph).all(workspace, schemaFamily));
      return { generation, receiptCount, headHash: row.head_hash, chainDigest };
    } catch (_) {
      return null;
    }
  }

  try {
    const journal = readJournalSnapshot(graph, opts);
    const receipts = Object.values(journal.receipts || {})
      .filter((receipt) => receipt?.workspaceId === workspace && receipt?.receiptFamily === schemaFamily);
    const generation = Object.keys(journal.operations || {}).length;
    const receiptCount = receipts.length;
    if (!receiptCount) return { generation, receiptCount: 0, headHash: GENESIS_PREVIOUS_HASH, chainDigest: chainDigestFromMembers([]) };
    const headHash = journal.chainTips?.[`${workspace}::${schemaFamily}`];
    if (!HASH_PATTERN.test(headHash || '')) return null;
    return { generation, receiptCount, headHash, chainDigest: chainDigestFromJournal(receipts) };
  } catch (_) {
    return null;
  }
}

module.exports = {
  getReceiptFamilyById,
  getReceiptStamp,
};
