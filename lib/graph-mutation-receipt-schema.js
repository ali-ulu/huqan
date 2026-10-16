'use strict';

const { classifyReceiptFamily } = require('./receipt/v4-receipt-family');
const {
  receiptFamilyMigrationError,
  RECEIPT_FAMILIES,
} = require('./graph-record-utils');

function ensureMutationReceiptFamilySchema(db) {
  const validateRows = () => {
    const rows = db.prepare(`
      SELECT sequence, canonical_payload, receipt_family
      FROM mutation_receipts
      ORDER BY sequence ASC
    `).all();
    for (const row of rows) {
      const payload = JSON.parse(row.canonical_payload);
      const derived = classifyReceiptFamily(payload);
      if (!RECEIPT_FAMILIES.has(row.receipt_family) || row.receipt_family !== derived) {
        throw new Error(`invalid mutation receipt family at sequence ${row.sequence}`);
      }
    }
    return rows.length;
  };
  const verifyIndex = () => {
    const columns = db.prepare("PRAGMA index_info('idx_mutation_receipts_workspace_family_sequence')")
      .all().map(row => row.name);
    if (columns.length !== 3
      || columns[0] !== 'workspace_id'
      || columns[1] !== 'receipt_family'
      || columns[2] !== 'sequence') {
      throw new Error('mutation receipt family index is incomplete');
    }
  };

  const columns = db.prepare('PRAGMA table_info(mutation_receipts)').all();
  const familyColumn = columns.find(column => column.name === 'receipt_family');
  try {
    if (!familyColumn) {
      db.transaction(() => {
        db.exec("ALTER TABLE mutation_receipts ADD COLUMN receipt_family TEXT NOT NULL DEFAULT 'non-v4' CHECK(receipt_family IN ('v4', 'non-v4'))");
        const rows = db.prepare('SELECT sequence, canonical_payload FROM mutation_receipts ORDER BY sequence ASC').all();
        const updateFamily = db.prepare('UPDATE mutation_receipts SET receipt_family = ? WHERE sequence = ?');
        let updated = 0;
        for (const row of rows) {
          const family = classifyReceiptFamily(JSON.parse(row.canonical_payload));
          if (!RECEIPT_FAMILIES.has(family)) {
            throw new Error(`unsupported mutation receipt family at sequence ${row.sequence}`);
          }
          const result = updateFamily.run(family, row.sequence);
          if (Number(result?.changes || 0) !== 1) {
            throw new Error(`mutation receipt family backfill mismatch at sequence ${row.sequence}`);
          }
          updated += 1;
        }
        if (updated !== rows.length || validateRows() !== rows.length) {
          throw new Error('mutation receipt family backfill is incomplete');
        }
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_mutation_receipts_workspace_family_sequence
          ON mutation_receipts(workspace_id, receipt_family, sequence DESC)
        `);
        verifyIndex();
      })();
      return;
    }

    if (Number(familyColumn.notnull) !== 1) {
      throw new Error('mutation receipt family column must be NOT NULL');
    }
    validateRows();
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mutation_receipts_workspace_family_sequence
      ON mutation_receipts(workspace_id, receipt_family, sequence DESC)
    `);
    verifyIndex();
  } catch (cause) {
    throw receiptFamilyMigrationError(cause);
  }
}

module.exports = {
  ensureMutationReceiptFamilySchema,
};
