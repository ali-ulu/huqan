'use strict';

/**
 * `coder --journal` composition root (#2388).
 *
 * `applyDerivation` never constructs a store (DIP #2118) — it receives a
 * journal. This module is the place that builds one for the CLI: open the
 * SQLite file at `--journal <path>`, apply the shared durability policy,
 * and hand over a journal plus a close function. Nothing here decides,
 * transforms, or records; it only connects.
 *
 * Durability class is EVIDENCE, not RESUMABLE: the journal rows are the
 * hash-chained pilot record (same class as `mutation_receipts` in
 * `lib/sqlite-durability.js`), and losing their tail loses the evidence
 * itself with nothing anywhere showing a gap.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { loadSqliteDriver, sqliteUnavailableError } = require('../sqlite-availability');
const { applySqliteDurability } = require('../sqlite-durability');
const { createExperienceJournal } = require('../experience/journal');
const { budgetExperienceJournal } = require('../experience/budgeted-journal');

function openCoderJournal(journalPath) {
  const candidate = String(journalPath || '');
  if (!candidate.trim()) throw new Error('coder --journal requires a database path');
  // No containment check against --root here: the journal database is the
  // operator's evidence store and legitimately lives outside the working
  // tree (a different disk, a shared folder). The operator invoking this CLI
  // can already write anywhere; a root check would be theatre, not safety.
  const absolute = nodePath.resolve(candidate);
  try {
    nodeFs.mkdirSync(nodePath.dirname(absolute), { recursive: true });
  } catch (error) {
    throw new Error(`coder --journal directory could not be created: ${error.message}`);
  }

  const { Database, loadError } = loadSqliteDriver();
  if (!Database) throw sqliteUnavailableError('coder --journal', loadError);
  let db;
  try {
    db = new Database(absolute);
  } catch (error) {
    throw new Error(`coder --journal database could not be opened at ${absolute}: ${error.message}`);
  }
  try {
    applySqliteDurability(db, 'EVIDENCE');
  } catch (error) {
    try { db.close(); } catch { /* best-effort: the open already failed */ }
    throw new Error(`coder --journal durability policy could not be applied: ${error.message}`);
  }

  const store = { db, withTransaction: (write) => db.transaction(write)() };
  const journal = budgetExperienceJournal(createExperienceJournal({ store }));
  return {
    journal,
    journalPath: absolute,
    close() {
      try { db.close(); } catch { /* best-effort: close of a CLI handle */ }
    },
  };
}

function journalPathOf(flags) {
  if (flags && typeof flags.journal === 'string' && flags.journal.trim()) return flags.journal;
  return '';
}

module.exports = {
  openCoderJournal,
  journalPathOf,
};
