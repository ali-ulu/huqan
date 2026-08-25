'use strict';

const { GENESIS_PREVIOUS_HASH } = require('./receipt-chain');
const { classifyRawMaterializedReceipt } = require('./canonical-receipt-v2');
const { normalizeWorkspaceId } = require('../graph-record-utils');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SQLITE_STAMP_STATEMENTS = new WeakMap();
const SQLITE_FAMILY_STATEMENTS = new WeakMap();

function rawReceiptFamily(receipt) {
  const kind = classifyRawMaterializedReceipt(receipt).kind;
  return kind === 'legacy_v1_unspecified' || kind === 'v2' ? 'v4' : null;
}

function getReceiptFamilyById(graph, receiptId, workspaceId) {
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

  const journal = graph._readJsonJournal();
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

function getReceiptStamp(graph, workspaceId = 'default', schemaFamily) {
  const workspace = normalizeWorkspaceId(workspaceId);
  if (schemaFamily !== 'v4') return null;

  if (graph._db && graph._stmts) {
    try {
      const row = sqliteStampStatement(graph).get(workspace, schemaFamily, workspace, schemaFamily);
      const generation = Number(row?.generation) || 0;
      const receiptCount = Number(row?.receipt_count) || 0;
      if (!receiptCount) return { generation, receiptCount: 0, headHash: GENESIS_PREVIOUS_HASH };
      if (!HASH_PATTERN.test(row?.head_hash || '')) return null;
      return { generation, receiptCount, headHash: row.head_hash };
    } catch (_) {
      return null;
    }
  }

  try {
    const journal = graph._readJsonJournal();
    const receipts = Object.values(journal.receipts || {})
      .filter((receipt) => receipt?.workspaceId === workspace && receipt?.receiptFamily === schemaFamily);
    const generation = Object.keys(journal.operations || {}).length;
    const receiptCount = receipts.length;
    if (!receiptCount) return { generation, receiptCount: 0, headHash: GENESIS_PREVIOUS_HASH };
    const headHash = journal.chainTips?.[`${workspace}::${schemaFamily}`];
    if (!HASH_PATTERN.test(headHash || '')) return null;
    return { generation, receiptCount, headHash };
  } catch (_) {
    return null;
  }
}

module.exports = {
  getReceiptFamilyById,
  getReceiptStamp,
};
