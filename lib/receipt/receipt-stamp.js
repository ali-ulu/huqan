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

function sqliteFamilyClause(schemaFamily) {
  if (schemaFamily === 'v4') {
    return `(
      json_extract(details, '$.receipt.canonicalReceiptSchemaVersion') IS NULL
      OR json_extract(details, '$.receipt.canonicalReceiptSchemaVersion') = 'v4-receipt-v2'
    )`;
  }
  return '0';
}

function sqliteStampStatement(graph, schemaFamily) {
  let statements = SQLITE_STAMP_STATEMENTS.get(graph);
  if (!statements) {
    statements = new Map();
    SQLITE_STAMP_STATEMENTS.set(graph, statements);
  }
  let statement = statements.get(schemaFamily);
  if (!statement) {
    const familyClause = sqliteFamilyClause(schemaFamily);
    statement = graph._db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM mutation_journal) AS generation,
        COUNT(*) AS receipt_count,
        (
          SELECT json_extract(details, '$.receipt.receiptHash')
          FROM audit_log
          WHERE workspace_id = ?
            AND json_extract(details, '$.receipt.receiptId') IS NOT NULL
            AND ${familyClause}
          ORDER BY timestamp DESC, audit_id DESC
          LIMIT 1
        ) AS head_hash
      FROM audit_log
      WHERE workspace_id = ?
        AND json_extract(details, '$.receipt.receiptId') IS NOT NULL
        AND ${familyClause}
    `);
    statements.set(schemaFamily, statement);
  }
  return statement;
}

function materializedReceiptRows(events, workspace, schemaFamily) {
  return events
    .filter((event) => normalizeWorkspaceId(event?.workspaceId) === workspace)
    .map((event) => ({
      auditId: String(event?.auditId || ''),
      timestamp: String(event?.timestamp || ''),
      receipt: event?.details?.receipt,
    }))
    .filter(({ receipt }) => receipt && typeof receipt === 'object'
      && receipt.receiptId && rawReceiptFamily(receipt) === schemaFamily)
    .sort((left, right) => {
      const timestampOrder = left.timestamp.localeCompare(right.timestamp);
      return timestampOrder || left.auditId.localeCompare(right.auditId);
    })
    .map(({ receipt }) => receipt);
}

function buildStamp(generation, receipts) {
  const receiptCount = receipts.length;
  if (!receiptCount) {
    return { generation, receiptCount: 0, headHash: GENESIS_PREVIOUS_HASH };
  }
  const headHash = receipts[receiptCount - 1]?.receiptHash;
  if (!HASH_PATTERN.test(headHash || '')) return null;
  return { generation, receiptCount, headHash };
}

function getReceiptStamp(graph, workspaceId = 'default', schemaFamily) {
  const workspace = normalizeWorkspaceId(workspaceId);
  if (schemaFamily !== 'v4') return null;

  if (graph._db && graph._stmts) {
    const row = sqliteStampStatement(graph, schemaFamily).get(workspace, workspace);
    const generation = Number(row?.generation) || 0;
    const receiptCount = Number(row?.receipt_count) || 0;
    if (!receiptCount) return { generation, receiptCount: 0, headHash: GENESIS_PREVIOUS_HASH };
    if (!HASH_PATTERN.test(row?.head_hash || '')) return null;
    return { generation, receiptCount, headHash: row.head_hash };
  }

  const journal = graph._readJsonJournal();
  const events = Array.isArray(graph._auditEvents)
    ? graph._auditEvents
    : typeof graph.getAuditEvents === 'function' ? graph.getAuditEvents({}) : [];
  return buildStamp(
    Object.keys(journal.operations).length,
    materializedReceiptRows(events, workspace, schemaFamily),
  );
}

module.exports = {
  getReceiptFamilyById,
  getReceiptStamp,
};
