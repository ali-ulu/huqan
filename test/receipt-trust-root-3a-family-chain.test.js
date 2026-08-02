'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Database = require('better-sqlite3');
const Graph = require('../graph');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { buildCanonicalReceiptPayloadV2 } = require('../lib/receipt/canonical-receipt-v2');
const { appendReceiptToChain, GENESIS_PREVIOUS_HASH } = require('../lib/receipt/receipt-chain');
const { V4_RECEIPT_ERROR_CODES } = require('../lib/receipt/v4-receipt-family');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-rtr3a-family-'));

const LEGACY_RECEIPT_TABLE = `
  CREATE TABLE mutation_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    receipt_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    canonical_payload TEXT NOT NULL,
    previous_receipt_hash TEXT NOT NULL,
    receipt_hash TEXT NOT NULL UNIQUE,
    committed_at TEXT NOT NULL
  );
`;

const FAMILY_RECEIPT_TABLE = `
  CREATE TABLE mutation_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    receipt_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    receipt_family TEXT NOT NULL,
    canonical_payload TEXT NOT NULL,
    previous_receipt_hash TEXT NOT NULL,
    receipt_hash TEXT NOT NULL UNIQUE,
    committed_at TEXT NOT NULL
  );
`;

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

function graphPaths(name) {
  return {
    memoryPath: path.join(root, `${name}.json`),
    dbPath: path.join(root, `${name}.db`),
  };
}

function makeGraph(name) {
  const paths = graphPaths(name);
  return new Graph({ ...paths, useSQLite: true });
}

function v4Payload(receiptId, workspaceId = 'w', metadata = {}) {
  return buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `admission-${receiptId}`,
    workspaceId,
    provenanceId: `provenance-${receiptId}`,
    trustPolicyVersion: 'rtr3a-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata,
  }, { verdict: 'allow' });
}

function v2Payload(receiptId, workspaceId = 'w') {
  return buildCanonicalReceiptPayloadV2({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `admission-${receiptId}`,
    workspaceId,
    provenanceId: `provenance-${receiptId}`,
    trustPolicyVersion: 'rtr3a-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
  }, { verdict: 'allow', trustRoot: 'local_operator' });
}

function nonV4Payload(receiptId, workspaceId = 'w', extra = {}) {
  return {
    version: 'huqan.reviewed-external-graph-receipt.v1',
    receiptId,
    operationId: `payload-operation-${receiptId}`,
    workspaceId,
    resultHash: `result-${receiptId}`,
    ...extra,
  };
}

function createLegacyStore(name, payloads) {
  const { dbPath } = graphPaths(name);
  const db = new Database(dbPath);
  db.exec(LEGACY_RECEIPT_TABLE);
  const insert = db.prepare(`
    INSERT INTO mutation_receipts (
      operation_id, receipt_id, workspace_id, canonical_payload,
      previous_receipt_hash, receipt_hash, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const records = [];
  let previousHash;
  payloads.forEach((payload, index) => {
    const chained = appendReceiptToChain(payload, previousHash);
    insert.run(
      `legacy-operation-${index + 1}`,
      payload.receiptId,
      payload.workspaceId,
      JSON.stringify(payload),
      chained.previousReceiptHash,
      chained.receiptHash,
      `2026-01-01T00:00:0${index}.000Z`,
    );
    records.push(chained);
    previousHash = chained.receiptHash;
  });
  const rows = db.prepare('SELECT * FROM mutation_receipts ORDER BY sequence ASC').all();
  db.close();
  return { records, rows };
}

function receiptRows(graph) {
  return graph._db.prepare('SELECT * FROM mutation_receipts ORDER BY sequence ASC').all();
}

function journalCount(graph, operationId) {
  return graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_journal WHERE operation_id = ?')
    .get(operationId).count;
}

test('legacy interleaved receipts migrate without rewriting evidence and future predecessors are family-scoped', () => {
  const legacyPayloads = [
    v4Payload('legacy-v4-1'),
    nonV4Payload('legacy-non-v4-1'),
    v4Payload('legacy-v4-2'),
    nonV4Payload('legacy-non-v4-2'),
  ];
  const legacy = createLegacyStore('interleaved', legacyPayloads);
  const graph = makeGraph('interleaved');

  try {
    assert.equal(graph.getStats().backend, 'sqlite');
    const migrated = receiptRows(graph);
    assert.deepEqual(migrated.map(row => row.receipt_family), ['v4', 'non-v4', 'v4', 'non-v4']);

    const immutableColumns = [
      'sequence', 'operation_id', 'receipt_id', 'workspace_id', 'canonical_payload',
      'previous_receipt_hash', 'receipt_hash', 'committed_at',
    ];
    for (let index = 0; index < legacy.rows.length; index += 1) {
      for (const column of immutableColumns) {
        assert.equal(migrated[index][column], legacy.rows[index][column], `${index}:${column}`);
      }
    }

    const indexColumns = graph._db.prepare("PRAGMA index_info('idx_mutation_receipts_workspace_family_sequence')")
      .all().map(row => row.name);
    assert.deepEqual(indexColumns, ['workspace_id', 'receipt_family', 'sequence']);

    const nextV4 = graph.runMutationOnce('next-v4', () => ({ changed: 'v4' }), {
      buildCanonicalReceipt: () => v4Payload('next-v4'),
    });
    assert.equal(nextV4.receipt.previousReceiptHash, legacy.records[2].receiptHash);

    const nextNonV4 = graph.runMutationOnce('next-non-v4', () => ({ changed: 'non-v4' }), {
      buildCanonicalReceipt: () => nonV4Payload('next-non-v4'),
    });
    assert.equal(nextNonV4.receipt.previousReceiptHash, legacy.records[3].receiptHash);

    const otherWorkspace = graph.runMutationOnce('other-workspace-v4', () => ({ changed: 'other' }), {
      buildCanonicalReceipt: () => v4Payload('other-workspace-v4', 'other-workspace'),
    });
    assert.equal(otherWorkspace.receipt.previousReceiptHash, GENESIS_PREVIOUS_HASH);

    const beforeReplayCount = receiptRows(graph).length;
    const replay = graph.runMutationOnce('next-v4', () => {
      throw new Error('must not execute replay');
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.receiptHash, nextV4.receipt.receiptHash);
    assert.equal(receiptRows(graph).length, beforeReplayCount);

    const v4Override = graph.runMutationOnce('v4-override', () => ({ changed: 'v4-override' }), {
      receiptFamily: 'non-v4',
      buildCanonicalReceipt: () => v4Payload('v4-override', 'w', {
        receipt_family: 'non-v4',
        receiptFamily: 'non-v4',
      }),
    });
    assert.equal(v4Override.receipt.previousReceiptHash, nextV4.receipt.receiptHash);

    const nonV4Override = graph.runMutationOnce('non-v4-override', () => ({ changed: 'non-v4-override' }), {
      receiptFamily: 'v4',
      buildCanonicalReceipt: () => nonV4Payload('non-v4-override', 'w', {
        receipt_family: 'v4',
        receiptFamily: 'v4',
        metadata: { receipt_family: 'v4' },
      }),
    });
    assert.equal(nonV4Override.receipt.previousReceiptHash, nextNonV4.receipt.receiptHash);

    const overrideRows = graph._db.prepare(`
      SELECT receipt_id, receipt_family
      FROM mutation_receipts
      WHERE receipt_id IN ('v4-override', 'non-v4-override')
      ORDER BY receipt_id ASC
    `).all();
    assert.deepEqual(overrideRows, [
      { receipt_id: 'non-v4-override', receipt_family: 'non-v4' },
      { receipt_id: 'v4-override', receipt_family: 'v4' },
    ]);

    assert.deepEqual(Object.keys(nonV4Override.receipt).sort(), [
      'canonicalPayload', 'committedAt', 'operationId', 'previousReceiptHash',
      'receiptHash', 'receiptId', 'workspaceId',
    ]);
    assert.equal(Object.hasOwn(nonV4Override.receipt, 'receiptFamily'), false);
  } finally {
    graph.close();
  }
});

test('callback, duplicate identity and SQLite receipt failures roll back database and in-memory state', () => {
  const graph = makeGraph('rollback');
  try {
    assert.throws(() => graph.runMutationOnce('callback-failure', () => {
      graph.addNode('callback-node', 'Callback Node', null, { workspaceId: 'w' });
      throw new Error('forced callback failure');
    }), /forced callback failure/);
    assert.equal(graph.getNode('callback-node', 'w'), null);
    assert.equal(journalCount(graph, 'callback-failure'), 0);

    graph.runMutationOnce('duplicate-source', () => ({ changed: true }), {
      buildCanonicalReceipt: () => v4Payload('duplicate-receipt'),
    });
    const afterSourceCount = receiptRows(graph).length;
    assert.throws(() => graph.runMutationOnce('duplicate-attempt', () => {
      graph.addNode('duplicate-node', 'Duplicate Node', null, { workspaceId: 'w' });
      return { changed: true };
    }, {
      buildCanonicalReceipt: () => v4Payload('duplicate-receipt'),
    }));
    assert.equal(graph.getNode('duplicate-node', 'w'), null);
    assert.equal(journalCount(graph, 'duplicate-attempt'), 0);
    assert.equal(receiptRows(graph).length, afterSourceCount);

    graph._db.exec(`
      CREATE TRIGGER rtr3a_force_receipt_failure
      BEFORE INSERT ON mutation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'forced receipt insertion failure');
      END;
    `);
    assert.throws(() => graph.runMutationOnce('sqlite-failure', () => {
      graph.addNode('sqlite-node', 'SQLite Node', null, { workspaceId: 'w' });
      return { changed: true };
    }, {
      buildCanonicalReceipt: () => v4Payload('sqlite-failure-receipt'),
    }), /forced receipt insertion failure/);
    graph._db.exec('DROP TRIGGER rtr3a_force_receipt_failure');

    assert.equal(graph.getNode('sqlite-node', 'w'), null);
    assert.equal(journalCount(graph, 'sqlite-failure'), 0);
    assert.equal(graph.getCommittedMutationReceiptByOperation('sqlite-failure'), null);
    assert.equal(receiptRows(graph).length, afterSourceCount);
  } finally {
    graph.close();
  }
});

test('durable V4 V2 writes remain fail-closed and leave zero observable state', () => {
  const graph = makeGraph('v2-guard');
  try {
    assert.throws(() => graph.runMutationOnce('blocked-v2', () => {
      graph.addNode('blocked-v2-node', 'Blocked V2', null, { workspaceId: 'w' });
      return { changed: true };
    }, {
      buildCanonicalReceipt: () => v2Payload('blocked-v2-receipt'),
    }), (error) => error?.code === V4_RECEIPT_ERROR_CODES.WRITE_NOT_ENABLED);

    assert.equal(graph.getNode('blocked-v2-node', 'w'), null);
    assert.equal(journalCount(graph, 'blocked-v2'), 0);
    assert.equal(receiptRows(graph).length, 0);
  } finally {
    graph.close();
  }
});

test('malformed legacy payload fails the family migration atomically without JSON fallback', () => {
  const paths = graphPaths('malformed');
  const db = new Database(paths.dbPath);
  db.exec(LEGACY_RECEIPT_TABLE);
  db.prepare(`
    INSERT INTO mutation_receipts (
      operation_id, receipt_id, workspace_id, canonical_payload,
      previous_receipt_hash, receipt_hash, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'malformed-operation', 'malformed-receipt', 'w', '{not-json',
    GENESIS_PREVIOUS_HASH, 'a'.repeat(64), '2026-01-01T00:00:00.000Z',
  );
  db.close();

  assert.throws(
    () => new Graph({ ...paths, useSQLite: true }),
    (error) => error?.code === 'RECEIPT_FAMILY_MIGRATION_FAILED',
  );

  const inspected = new Database(paths.dbPath, { readonly: true });
  try {
    const columns = inspected.prepare('PRAGMA table_info(mutation_receipts)').all().map(row => row.name);
    assert.equal(columns.includes('receipt_family'), false);
    assert.equal(inspected.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_mutation_receipts_workspace_family_sequence'
    `).get().count, 0);
  } finally {
    inspected.close();
  }
  assert.equal(fs.existsSync(paths.memoryPath), false);
});

test('ignored backfill and invalid existing family metadata fail with the single migration error', () => {
  const ignoredPaths = graphPaths('ignored-backfill');
  const ignoredDb = new Database(ignoredPaths.dbPath);
  ignoredDb.exec(LEGACY_RECEIPT_TABLE);
  const payload = v4Payload('ignored-v4');
  const chained = appendReceiptToChain(payload);
  ignoredDb.prepare(`
    INSERT INTO mutation_receipts (
      operation_id, receipt_id, workspace_id, canonical_payload,
      previous_receipt_hash, receipt_hash, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'ignored-operation', payload.receiptId, payload.workspaceId, JSON.stringify(payload),
    chained.previousReceiptHash, chained.receiptHash, '2026-01-01T00:00:00.000Z',
  );
  ignoredDb.exec(`
    CREATE TRIGGER rtr3a_ignore_backfill
    BEFORE UPDATE ON mutation_receipts
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
  ignoredDb.close();

  assert.throws(
    () => new Graph({ ...ignoredPaths, useSQLite: true }),
    (error) => error?.code === 'RECEIPT_FAMILY_MIGRATION_FAILED',
  );
  const ignoredInspect = new Database(ignoredPaths.dbPath, { readonly: true });
  try {
    assert.equal(
      ignoredInspect.prepare('PRAGMA table_info(mutation_receipts)').all()
        .some(row => row.name === 'receipt_family'),
      false,
    );
  } finally {
    ignoredInspect.close();
  }

  const invalidPaths = graphPaths('invalid-family');
  const invalidDb = new Database(invalidPaths.dbPath);
  invalidDb.exec(FAMILY_RECEIPT_TABLE);
  invalidDb.prepare(`
    INSERT INTO mutation_receipts (
      operation_id, receipt_id, workspace_id, receipt_family, canonical_payload,
      previous_receipt_hash, receipt_hash, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'invalid-operation', payload.receiptId, payload.workspaceId, 'wrong-family', JSON.stringify(payload),
    chained.previousReceiptHash, chained.receiptHash, '2026-01-01T00:00:00.000Z',
  );
  invalidDb.close();

  assert.throws(
    () => new Graph({ ...invalidPaths, useSQLite: true }),
    (error) => error?.code === 'RECEIPT_FAMILY_MIGRATION_FAILED',
  );
});
