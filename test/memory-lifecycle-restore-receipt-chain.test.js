'use strict';

/**
 * Lifecycle smoke slice — restore → receipt-chain semantics.
 *
 * Task-mapping note (#90): lib/memory-store.js has no receipt concept at all
 * (verified at main d67b2722: zero receipt references in that module). The two
 * real receipt surfaces on the restore path are:
 *
 *   1. backupRestore.js::restoreBackup — produces an operation receipt
 *      (buildOperationReceipt) and refuses to report success unless its
 *      post-restore verification (persistence/schema/graphIntegrity/receipt)
 *      passes.
 *   2. The durable canonical receipt chain — Graph.runMutationOnce commits
 *      hash-linked receipts into the `mutation_receipts` SQLite table (or the
 *      JSON mutation journal), and lib/receipt/receipt-chain.js
 *      (validateReceiptChain) is the primitive that proves a chain is intact.
 *      `memory.db` — the file restore actually replaces — carries that table.
 *
 * This file pins the lifecycle contract at store level, programmatically:
 * after a backup → mutate → restore round trip, the restored receipt chain
 * must still validate, a tampered restored receipt must be rejected with
 * content_tampered, a removed receipt must break the chain link, and new
 * durable mutations must chain onto the restored tip.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const Graph = require('../graph');
const { createBackup, restoreBackup } = require('../backupRestore');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const {
  GENESIS_PREVIOUS_HASH,
  CHAIN_INVALID_REASONS,
  validateReceiptChain,
} = require('../lib/receipt/receipt-chain');
const Database = require('better-sqlite3');

const baseReceipt = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt-trust-root', '01-v1-canonical-bytes.json'), 'utf8')
).input.receipt;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-lifecycle-restore-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

let receiptSeq = 0;

/** Distinct valid V1 canonical receipt payload per call (receipt_id is UNIQUE in SQLite). */
function lifecycleReceipt(workspaceId) {
  receiptSeq += 1;
  const suffix = String(receiptSeq).padStart(4, '0');
  return buildCanonicalReceiptPayload({
    ...structuredClone(baseReceipt),
    receiptId: `receipt-lifecycle-${suffix}`,
    admissionId: `admission-lifecycle-${suffix}`,
    memoryDraftId: `draft-lifecycle-${suffix}`,
    workspaceId,
  }, { verdict: 'allow' });
}

function commitReceipt(graph, operationId, workspaceId) {
  return graph.runMutationOnce(operationId, () => ({ committed: true }), {
    buildCanonicalReceipt: () => lifecycleReceipt(workspaceId),
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
  };
}

function commitThreeReceipts(opts) {
  const graph = new Graph({ memoryPath: opts.memoryPath, dbPath: opts.dbPath, useSQLite: true });
  try {
    for (const operationId of ['op-lifecycle-001', 'op-lifecycle-002', 'op-lifecycle-003']) {
      const outcome = commitReceipt(graph, operationId, 'ws-lifecycle');
      assert.equal(outcome.replayed, false);
      assert.ok(outcome.receipt && outcome.receipt.receiptHash, `receipt committed for ${operationId}`);
    }
  } finally {
    graph.close();
  }
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

function writeMutationReceipts(dbPath, statement, ...args) {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.prepare(statement).run(...args);
  } finally {
    db.close();
  }
}

describe('Lifecycle smoke: restore → receipt chain', () => {
  it('restore reports a complete operation receipt and the restored chain validates', () => {
    const opts = makeHarness('happy-path');
    commitThreeReceipts(opts);

    const backup = createBackup({ ...opts, backupId: 'lifecycle-source', keepLast: 5 });
    assert.equal(backup.ok, true);
    assert.ok(backup.manifest.files.includes('memory.db'), 'memory.db is part of the backup');

    // Destructively change live state so the restore must actually replace it.
    writeMutationReceipts(opts.dbPath, 'DELETE FROM mutation_receipts');
    assert.equal(readReceiptRows(opts.dbPath).length, 0, 'live state is no longer the backed-up state');

    const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
    assert.equal(restored.ok, true);
    assert.ok(restored.restored.includes('memory.db'));
    assert.equal(restored.receipt.kind, 'restore');
    assert.equal(restored.receipt.status, 'complete');
    assert.ok(restored.receipt.operationId.startsWith('restoreop_'));
    assert.deepEqual(restored.verification, { persistence: true, schema: true, graphIntegrity: true, receipt: true });

    const rows = readReceiptRows(opts.dbPath);
    assert.equal(rows.length, 3);
    const chain = chainFromRows(rows);
    assert.deepEqual(validateReceiptChain(chain), { valid: true, brokenAt: null, reason: null });
    assert.equal(chain[0].previousReceiptHash, GENESIS_PREVIOUS_HASH);
    for (let i = 1; i < chain.length; i++) {
      assert.equal(chain[i].previousReceiptHash, chain[i - 1].receiptHash, `link ${i - 1} -> ${i} intact after restore`);
    }
  });

  it('a tampered restored receipt is rejected as content_tampered', () => {
    const opts = makeHarness('tampered');
    commitThreeReceipts(opts);

    const backup = createBackup({ ...opts, backupId: 'lifecycle-tamper', keepLast: 5 });
    assert.equal(backup.ok, true);
    const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
    assert.equal(restored.ok, true);

    // Rewrite one restored receipt's canonical payload behind the hash.
    const tampered = JSON.stringify({
      ...JSON.parse(readReceiptRows(opts.dbPath)[1].canonical_payload),
      decision: 'reject',
    });
    writeMutationReceipts(opts.dbPath, 'UPDATE mutation_receipts SET canonical_payload = ? WHERE sequence = 2', tampered);

    const chain = chainFromRows(readReceiptRows(opts.dbPath));
    const verdict = validateReceiptChain(chain);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAt, 1);
    assert.equal(verdict.reason, CHAIN_INVALID_REASONS.CONTENT_TAMPERED);
  });

  it('a receipt removed from the restored chain breaks the chain link', () => {
    const opts = makeHarness('removed');
    commitThreeReceipts(opts);

    const backup = createBackup({ ...opts, backupId: 'lifecycle-removed', keepLast: 5 });
    assert.equal(backup.ok, true);
    const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
    assert.equal(restored.ok, true);

    writeMutationReceipts(opts.dbPath, 'DELETE FROM mutation_receipts WHERE sequence = 2');

    const chain = chainFromRows(readReceiptRows(opts.dbPath));
    assert.equal(chain.length, 2);
    const verdict = validateReceiptChain(chain);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAt, 1);
    assert.equal(verdict.reason, CHAIN_INVALID_REASONS.CHAIN_LINK_BROKEN);
  });

  it('new durable mutations chain onto the restored tip and replay idempotently', () => {
    const opts = makeHarness('extend');
    commitThreeReceipts(opts);

    const backup = createBackup({ ...opts, backupId: 'lifecycle-extend', keepLast: 5 });
    assert.equal(backup.ok, true);
    const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
    assert.equal(restored.ok, true);

    const graph = new Graph({ memoryPath: opts.memoryPath, dbPath: opts.dbPath, useSQLite: true });
    try {
      const first = commitReceipt(graph, 'op-lifecycle-004', 'ws-lifecycle');
      assert.equal(first.replayed, false);
      assert.ok(first.receipt && first.receipt.receiptHash);

      const replay = commitReceipt(graph, 'op-lifecycle-004', 'ws-lifecycle');
      assert.equal(replay.replayed, true);
      assert.equal(replay.receipt.receiptId, first.receipt.receiptId);
    } finally {
      graph.close();
    }

    const rows = readReceiptRows(opts.dbPath);
    assert.equal(rows.length, 4);
    assert.equal(rows[3].previous_receipt_hash, rows[2].receipt_hash, 'new receipt linked to the restored tip');
    const verdict = validateReceiptChain(chainFromRows(rows));
    assert.equal(verdict.valid, true);
  });
});
