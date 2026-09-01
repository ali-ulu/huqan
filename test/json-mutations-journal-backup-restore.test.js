'use strict';

/**
 * JSON-mode mutation journal backup/restore.
 *
 * backupRestore.js::resolveRuntimePaths built the backup file set from
 * persistencePaths.js, which does not know about the JSON backend's mutation
 * journal (memory.mutations.json — the receipt chain + operation replay
 * authority that graph.js writes via derivePersistenceLayout). A JSON-mode
 * backup → restore round trip therefore lost the receipt chain and the
 * journal. These tests pin the repaired seam:
 *
 *   - the journal is part of the backup package and comes back on restore;
 *   - after a round trip the restored receipt chain validates and replay is
 *     idempotent, and new durable mutations chain onto the restored tip;
 *   - legacy backups without a journal restore successfully: the journal is
 *     reported skipped, restore fabricates nothing, and JSON mode continues
 *     from the documented empty history (lib/mutation-journal.js: a journal
 *     that is not there is a legitimate empty state);
 *   - a journal that is present but unreadable is rejected before restore
 *     replaces live state (same fail-closed rule as memory.json);
 *   - SQLite mode is unchanged: its journal lives in the database, so the
 *     derived journal path stays skipped in both directions.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const Graph = require('../graph');
const { createBackup, restoreBackup } = require('../backupRestore');
const { readMutationJournal } = require('../lib/mutation-journal');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const {
  GENESIS_PREVIOUS_HASH,
  validateReceiptChain,
} = require('../lib/receipt/receipt-chain');
const Database = require('better-sqlite3');

const baseReceipt = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt-trust-root', '01-v1-canonical-bytes.json'), 'utf8')
).input.receipt;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-json-journal-backup-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

let receiptSeq = 0;

/** Distinct valid V1 canonical receipt payload per call (receiptId is UNIQUE). */
function journalReceipt(workspaceId) {
  receiptSeq += 1;
  const suffix = String(receiptSeq).padStart(4, '0');
  return buildCanonicalReceiptPayload({
    ...structuredClone(baseReceipt),
    receiptId: `receipt-jbr-${suffix}`,
    admissionId: `admission-jbr-${suffix}`,
    memoryDraftId: `draft-jbr-${suffix}`,
    workspaceId,
  }, { verdict: 'allow' });
}

function commitReceipt(graph, operationId, workspaceId) {
  return graph.runMutationOnce(operationId, () => ({ committed: true }), {
    buildCanonicalReceipt: () => journalReceipt(workspaceId),
  });
}

/** Storage layout fully contained in its own subdirectory of the shared temp root. */
function makeHarness(label) {
  const rootDir = path.join(tempRoot, label);
  fs.mkdirSync(rootDir, { recursive: true });
  return {
    rootDir,
    memoryPath: path.join(rootDir, 'memory.json'),
    dbPath: path.join(rootDir, 'memory.db'),
    backupBaseDir: path.join(rootDir, 'backups'),
    journalPath: path.join(rootDir, 'memory.mutations.json'),
  };
}

function emptyJournal() {
  return { operations: {}, receipts: {}, chainTips: {}, receiptsById: {} };
}

/**
 * Chain records in commit order. The journal preserves its own insertion
 * order across a JSON round trip, and every commit appends in commit order,
 * so Object.values order is the chain order without trusting timestamps.
 */
function chainFromJournal(journalPath) {
  return Object.values(readMutationJournal(journalPath).receipts).map((entry) => ({
    ...entry.canonicalPayload,
    previousReceiptHash: entry.previousReceiptHash,
    receiptHash: entry.receiptHash,
  }));
}

function readReceiptRows(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT receipt_id, workspace_id, receipt_family, canonical_payload,
             previous_receipt_hash, receipt_hash, committed_at
      FROM mutation_receipts
      ORDER BY sequence ASC
    `).all();
  } finally {
    db.close();
  }
}

function chainFromRows(rows) {
  return rows.map((row) => ({
    ...JSON.parse(row.canonical_payload),
    previousReceiptHash: row.previous_receipt_hash,
    receiptHash: row.receipt_hash,
  }));
}

describe('JSON mutation journal backup/restore', () => {
  it('packages the JSON mutation journal into the backup and restores it verbatim', () => {
    const opts = makeHarness('package-roundtrip');
    fs.writeFileSync(opts.memoryPath, JSON.stringify({ ok: true }));
    fs.writeFileSync(opts.journalPath, JSON.stringify(emptyJournal()));

    const backup = createBackup({ ...opts, backupId: 'jbr-package', keepLast: 5 });
    assert.equal(backup.ok, true);
    assert.ok(backup.manifest.files.includes('memory.mutations.json'), 'journal is part of the backup package');
    assert.ok(fs.existsSync(path.join(backup.backupDir, 'memory.mutations.json')));

    // Destructively change the live journal so restore must actually replace it.
    fs.writeFileSync(opts.journalPath, JSON.stringify({ operations: { lost: {} }, receipts: {}, chainTips: {}, receiptsById: {} }));

    const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
    assert.equal(restored.ok, true);
    assert.ok(restored.restored.includes('memory.mutations.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(opts.journalPath, 'utf8')), emptyJournal());
  });

  it('backup → restore round trip keeps the receipt chain valid and replay idempotent (JSON mode)', () => {
    const opts = makeHarness('receipt-roundtrip');
    const graph = new Graph({ memoryPath: opts.memoryPath, useSQLite: false, noLoad: true });
    try {
      for (const operationId of ['op-jbr-001', 'op-jbr-002']) {
        const outcome = commitReceipt(graph, operationId, 'ws-jbr');
        assert.equal(outcome.replayed, false);
        assert.ok(outcome.receipt && outcome.receipt.receiptHash, `receipt committed for ${operationId}`);
      }
    } finally {
      graph.close();
    }

    const backup = createBackup({ ...opts, backupId: 'jbr-chain', keepLast: 5 });
    assert.equal(backup.ok, true);
    assert.ok(backup.manifest.files.includes('memory.mutations.json'), 'journal is part of the backup package');

    // Destructively lose the live journal and graph state so the restore must
    // actually replace them.
    fs.rmSync(opts.journalPath, { force: true });
    fs.writeFileSync(opts.memoryPath, JSON.stringify({ lost: true }));

    const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
    assert.equal(restored.ok, true);
    assert.ok(restored.restored.includes('memory.mutations.json'));

    // The restored chain validates.
    const chain = chainFromJournal(opts.journalPath);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].previousReceiptHash, GENESIS_PREVIOUS_HASH);
    assert.deepEqual(validateReceiptChain(chain), { valid: true, brokenAt: null, reason: null });

    const reopened = new Graph({ memoryPath: opts.memoryPath, useSQLite: false, noLoad: true });
    try {
      // Replay of an already-committed operation stays idempotent after restore.
      let executions = 0;
      const replay = reopened.runMutationOnce('op-jbr-001', () => { executions += 1; return {}; });
      assert.equal(replay.replayed, true);
      assert.equal(executions, 0, 'a replayed operation must not re-execute after restore');

      // New durable mutations chain onto the restored tip.
      const fresh = commitReceipt(reopened, 'op-jbr-003', 'ws-jbr');
      assert.equal(fresh.replayed, false);
      assert.ok(fresh.receipt && fresh.receipt.receiptHash);
    } finally {
      reopened.close();
    }

    const extended = chainFromJournal(opts.journalPath);
    assert.equal(extended.length, 3);
    assert.equal(extended[2].previousReceiptHash, extended[1].receiptHash, 'new receipt linked to the restored tip');
    assert.deepEqual(validateReceiptChain(extended), { valid: true, brokenAt: null, reason: null });
  });

  it('a legacy backup without a journal restores successfully and JSON mode continues from the documented empty history', () => {
    const opts = makeHarness('legacy');
    // Seed a valid, loadable graph file through the graph's own save().
    const seed = new Graph({ memoryPath: opts.memoryPath, useSQLite: false, noLoad: true });
    try { seed.save(); } finally { seed.close(); }
    fs.writeFileSync(opts.journalPath, JSON.stringify(emptyJournal()));

    const backup = createBackup({ ...opts, backupId: 'jbr-legacy', keepLast: 5 });
    // Reduce the package to its pre-journal shape: no journal file, and no
    // journal name in the manifest — what a backup made before this file
    // existed looks like.
    fs.rmSync(path.join(backup.backupDir, 'memory.mutations.json'), { force: true });
    const manifestPath = path.join(backup.backupDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      files: manifest.files.filter((name) => name !== 'memory.mutations.json'),
    }));

    fs.rmSync(opts.journalPath, { force: true });
    const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
    assert.equal(restored.ok, true, 'a journal-less legacy backup restores successfully');
    assert.ok(!restored.restored.includes('memory.mutations.json'), 'nothing journal-shaped to restore');
    assert.ok(restored.skipped.includes('memory.mutations.json'), 'the journal is reported skipped');
    assert.ok(!fs.existsSync(opts.journalPath), 'restore does not fabricate a journal');

    // Documented empty-history semantics: a journal that is not there is a
    // legitimate empty state, so new receipts start a fresh genesis chain.
    const graph = new Graph({ memoryPath: opts.memoryPath, useSQLite: false, noLoad: true });
    try {
      const outcome = commitReceipt(graph, 'op-jbr-legacy-1', 'ws-jbr');
      assert.equal(outcome.replayed, false);
    } finally {
      graph.close();
    }
    const chain = chainFromJournal(opts.journalPath);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].previousReceiptHash, GENESIS_PREVIOUS_HASH);
    assert.deepEqual(validateReceiptChain(chain), { valid: true, brokenAt: null, reason: null });
  });

  it('a corrupt journal inside a backup is rejected before live state is replaced', () => {
    const opts = makeHarness('corrupt');
    fs.writeFileSync(opts.memoryPath, JSON.stringify({ version: 1 }));
    fs.writeFileSync(opts.journalPath, '{not-json');

    const backup = createBackup({ ...opts, backupId: 'jbr-corrupt', keepLast: 5 });
    assert.equal(backup.ok, true, 'backup copies what exists; restore validates the source');
    fs.writeFileSync(opts.memoryPath, JSON.stringify({ version: 2 }));

    assert.throws(
      () => restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 }),
      (error) => error?.code === 'RESTORE_SOURCE_INVALID'
        && error.validation?.file === 'memory.mutations.json',
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(opts.memoryPath, 'utf8')), { version: 2 }, 'live state untouched');
    assert.deepEqual(fs.readdirSync(opts.backupBaseDir), ['jbr-corrupt'], 'no pre-restore safety backup on a rejected source');
  });

  it('SQLite mode is unchanged: the journal file stays skipped in both directions and the database chain still validates', () => {
    const opts = makeHarness('sqlite');
    const graph = new Graph({ memoryPath: opts.memoryPath, dbPath: opts.dbPath, useSQLite: true });
    try {
      const outcome = commitReceipt(graph, 'op-jbr-sql-1', 'ws-jbr');
      assert.equal(outcome.replayed, false);
      assert.ok(outcome.receipt && outcome.receipt.receiptHash);
    } finally {
      graph.close();
    }

    const backup = createBackup({ ...opts, backupId: 'jbr-sql', keepLast: 5 });
    assert.equal(backup.ok, true);
    assert.ok(!backup.manifest.files.includes('memory.mutations.json'), 'the journal file is not part of a SQLite-mode package');
    assert.ok(backup.skipped.includes('memory.mutations.json'), 'the derived journal path is skipped when absent');
    assert.ok(backup.manifest.files.includes('memory.db'));

    // Destructively lose the live database so the restore must replace it.
    fs.rmSync(opts.dbPath, { force: true });

    const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
    assert.equal(restored.ok, true);
    assert.ok(restored.restored.includes('memory.db'));
    assert.ok(!restored.restored.includes('memory.mutations.json'), 'no journal file restored in SQLite mode');

    const rows = readReceiptRows(opts.dbPath);
    assert.equal(rows.length, 1);
    assert.deepEqual(validateReceiptChain(chainFromRows(rows)), { valid: true, brokenAt: null, reason: null });
  });
});
