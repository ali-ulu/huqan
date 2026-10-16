'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Database = require('better-sqlite3');
const Graph = require('../graph');
const {
  buildCanonicalReceiptPayload,
  hashCanonicalReceiptPayload,
  sha256Hex,
  stableStringify,
} = require('../lib/receipt/canonical-receipt');
const {
  buildCanonicalReceiptPayloadV2,
  classifyRawMaterializedReceipt,
  validateCanonicalReceiptV2,
} = require('../lib/receipt/canonical-receipt-v2');
const {
  appendReceiptToChain,
  GENESIS_PREVIOUS_HASH,
  validateReceiptChain,
} = require('../lib/receipt/receipt-chain');
const {
  exportReceiptBundle,
  verifyExportedBundle,
} = require('../lib/receipt/receipt-export');
const {
  buildMaterializedReceiptChain,
  readReceiptById,
} = require('../lib/receipt/receipt-read-index');
const {
  classifyReceiptFamily,
  validateV4Chain,
  V4_RECEIPT_ERROR_CODES,
} = require('../lib/receipt/v4-receipt-family');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-rtr4-'));
const fixtureDir = path.join(__dirname, 'fixtures', 'receipt-trust-root');
const fixtures = fs.readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')));
const byId = new Map(fixtures.map((fixture) => [fixture.caseId, fixture]));
const baseReceipt = byId.get('RTR-001-V1-CANONICAL-BYTES').input.receipt;

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
    receipt_family TEXT NOT NULL CHECK(receipt_family IN ('v4', 'non-v4')),
    canonical_payload TEXT NOT NULL,
    previous_receipt_hash TEXT NOT NULL,
    receipt_hash TEXT NOT NULL UNIQUE,
    committed_at TEXT NOT NULL
  );
`;

const NULLABLE_FAMILY_RECEIPT_TABLE = `
  CREATE TABLE mutation_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    receipt_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    receipt_family TEXT,
    canonical_payload TEXT NOT NULL,
    previous_receipt_hash TEXT NOT NULL,
    receipt_hash TEXT NOT NULL UNIQUE,
    committed_at TEXT NOT NULL
  );
`;

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

function pathsFor(name) {
  return {
    memoryPath: path.join(root, `${name}.json`),
    dbPath: path.join(root, `${name}.db`),
  };
}

function v1(overrides = {}) {
  return buildCanonicalReceiptPayload({
    ...structuredClone(baseReceipt),
    ...overrides,
  }, { verdict: 'allow' });
}

function v2(trustRoot, overrides = {}) {
  return buildCanonicalReceiptPayloadV2({
    ...structuredClone(baseReceipt),
    ...overrides,
  }, { verdict: 'allow', trustRoot });
}

function materializedV2(trustRoot, overrides = {}) {
  return {
    ...structuredClone(baseReceipt),
    ...overrides,
    canonicalReceiptSchemaVersion: 'v4-receipt-v2',
    trustRoot,
  };
}

function nonV4(receiptId, workspaceId = 'workspace-fixed', extra = {}) {
  return {
    version: 'huqan.reviewed-external-graph-receipt.v1',
    receiptId,
    operationId: `operation-${receiptId}`,
    workspaceId,
    resultHash: `result-${receiptId}`,
    ...extra,
  };
}

function insertReceiptRows(db, payloads) {
  const insert = db.prepare(`
    INSERT INTO mutation_receipts (
      operation_id, receipt_id, workspace_id, canonical_payload,
      previous_receipt_hash, receipt_hash, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const rows = [];
  let previousReceiptHash;
  payloads.forEach((payload, index) => {
    const chained = appendReceiptToChain(payload, previousReceiptHash);
    insert.run(
      `legacy-operation-${index + 1}`,
      payload.receiptId,
      payload.workspaceId,
      JSON.stringify(payload),
      chained.previousReceiptHash,
      chained.receiptHash,
      `2026-01-01T00:00:0${index}.000Z`,
    );
    rows.push(chained);
    previousReceiptHash = chained.receiptHash;
  });
  return rows;
}

function receiptRows(db) {
  return db.prepare('SELECT * FROM mutation_receipts ORDER BY sequence ASC').all();
}

function assertTypedMigrationFailure(name, setup) {
  const paths = pathsFor(name);
  const db = new Database(paths.dbPath);
  setup(db);
  db.close();
  assert.throws(
    () => new Graph({ ...paths, useSQLite: true }),
    (error) => error?.code === 'RECEIPT_FAMILY_MIGRATION_FAILED',
  );
  assert.equal(fs.existsSync(paths.memoryPath), false);
}

test('legacy SQLite migration is evidence-preserving, family-scoped and idempotent across reopen', () => {
  const paths = pathsFor('migration-reopen');
  const legacyDb = new Database(paths.dbPath);
  legacyDb.exec(LEGACY_RECEIPT_TABLE);
  const payloads = [
    v1({ receiptId: 'w1-v4-1', admissionId: 'w1-a1', workspaceId: 'w1' }),
    nonV4('w1-non-v4-1', 'w1'),
    v1({ receiptId: 'w2-v4-1', admissionId: 'w2-a1', workspaceId: 'w2' }),
    nonV4('w2-non-v4-1', 'w2'),
    v1({ receiptId: 'w1-v4-2', admissionId: 'w1-a2', workspaceId: 'w1' }),
  ];
  const chained = insertReceiptRows(legacyDb, payloads);
  const before = receiptRows(legacyDb);
  legacyDb.close();

  const graph = new Graph({ ...paths, useSQLite: true });
  try {
    assert.equal(graph.getStats().backend, 'sqlite');
    const migrated = receiptRows(graph._db);
    assert.deepEqual(migrated.map((row) => row.receipt_family), ['v4', 'non-v4', 'v4', 'non-v4', 'v4']);
    for (let index = 0; index < before.length; index += 1) {
      for (const column of [
        'sequence', 'operation_id', 'receipt_id', 'workspace_id', 'canonical_payload',
        'previous_receipt_hash', 'receipt_hash', 'committed_at',
      ]) {
        assert.equal(migrated[index][column], before[index][column], `${index}:${column}`);
      }
    }
    assert.deepEqual(
      graph._db.prepare("PRAGMA index_info('idx_mutation_receipts_workspace_family_sequence')")
        .all().map((row) => row.name),
      ['workspace_id', 'receipt_family', 'sequence'],
    );

    const nextW1V4 = graph.runMutationOnce('next-w1-v4', () => ({ changed: true }), {
      receiptFamily: 'non-v4',
      buildCanonicalReceipt: () => v1({
        receiptId: 'next-w1-v4',
        admissionId: 'next-w1-v4-admission',
        workspaceId: 'w1',
        metadata: { receiptFamily: 'non-v4', receipt_family: 'non-v4' },
      }),
    });
    assert.equal(nextW1V4.receipt.previousReceiptHash, chained[4].receiptHash);

    const nextW1NonV4 = graph.runMutationOnce('next-w1-non-v4', () => ({ changed: true }), {
      receiptFamily: 'v4',
      buildCanonicalReceipt: () => nonV4('next-w1-non-v4', 'w1', {
        receiptFamily: 'v4',
        receipt_family: 'v4',
        metadata: { receiptFamily: 'v4' },
      }),
    });
    assert.equal(nextW1NonV4.receipt.previousReceiptHash, chained[1].receiptHash);

    const nextW2V4 = graph.runMutationOnce('next-w2-v4', () => ({ changed: true }), {
      buildCanonicalReceipt: () => v1({
        receiptId: 'next-w2-v4',
        admissionId: 'next-w2-v4-admission',
        workspaceId: 'w2',
      }),
    });
    assert.equal(nextW2V4.receipt.previousReceiptHash, chained[2].receiptHash);
  } finally {
    graph.close();
  }

  const reopened = new Graph({ ...paths, useSQLite: true });
  try {
    const rows = receiptRows(reopened._db);
    assert.equal(rows.length, before.length + 3);
    assert.deepEqual(
      reopened._db.prepare("PRAGMA index_info('idx_mutation_receipts_workspace_family_sequence')")
        .all().map((row) => row.name),
      ['workspace_id', 'receipt_family', 'sequence'],
    );
    for (let index = 0; index < before.length; index += 1) {
      assert.equal(rows[index].canonical_payload, before[index].canonical_payload);
      assert.equal(rows[index].receipt_hash, before[index].receipt_hash);
    }
  } finally {
    reopened.close();
  }
});

test('migration integrity failures stay typed and never fall back to JSON', () => {
  assertTypedMigrationFailure('nullable-family', (db) => {
    db.exec(NULLABLE_FAMILY_RECEIPT_TABLE);
  });

  assertTypedMigrationFailure('inconsistent-family', (db) => {
    db.exec(FAMILY_RECEIPT_TABLE);
    const payload = v1({ receiptId: 'mislabeled-v4', admissionId: 'mislabeled-a' });
    const chained = appendReceiptToChain(payload);
    db.prepare(`
      INSERT INTO mutation_receipts (
        operation_id, receipt_id, workspace_id, receipt_family, canonical_payload,
        previous_receipt_hash, receipt_hash, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'mislabeled-operation', payload.receiptId, payload.workspaceId, 'non-v4',
      JSON.stringify(payload), chained.previousReceiptHash, chained.receiptHash,
      '2026-01-01T00:00:00.000Z',
    );
  });

  assertTypedMigrationFailure('wrong-index', (db) => {
    db.exec(FAMILY_RECEIPT_TABLE);
    db.exec(`
      CREATE INDEX idx_mutation_receipts_workspace_family_sequence
      ON mutation_receipts(receipt_family, workspace_id, sequence DESC)
    `);
  });

  assertTypedMigrationFailure('malformed-json', (db) => {
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
  });

  const repairPaths = pathsFor('missing-index-repair');
  const repairDb = new Database(repairPaths.dbPath);
  repairDb.exec(FAMILY_RECEIPT_TABLE);
  const payload = v1({ receiptId: 'repair-v4', admissionId: 'repair-a' });
  const chained = appendReceiptToChain(payload);
  repairDb.prepare(`
    INSERT INTO mutation_receipts (
      operation_id, receipt_id, workspace_id, receipt_family, canonical_payload,
      previous_receipt_hash, receipt_hash, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'repair-operation', payload.receiptId, payload.workspaceId, 'v4',
    JSON.stringify(payload), chained.previousReceiptHash, chained.receiptHash,
    '2026-01-01T00:00:00.000Z',
  );
  repairDb.close();
  const repaired = new Graph({ ...repairPaths, useSQLite: true });
  try {
    assert.deepEqual(
      repaired._db.prepare("PRAGMA index_info('idx_mutation_receipts_workspace_family_sequence')")
        .all().map((row) => row.name),
      ['workspace_id', 'receipt_family', 'sequence'],
    );
    const row = receiptRows(repaired._db)[0];
    assert.equal(row.canonical_payload, JSON.stringify(payload));
    assert.equal(row.receipt_hash, chained.receiptHash);
  } finally {
    repaired.close();
  }
});

test('historical V1 payload, chain and bundle bytes remain exact and immutable', () => {
  const fixture1 = byId.get('RTR-001-V1-CANONICAL-BYTES');
  const fixture2 = byId.get('RTR-002-V1-CANONICAL-HASH');
  const fixture3 = byId.get('RTR-003-V1-CHAIN-LINKAGE');
  const fixture4 = byId.get('RTR-004-V1-BUNDLE-BYTES');

  const raw = structuredClone(fixture1.input.receipt);
  const rawBefore = structuredClone(raw);
  const firstPayload = buildCanonicalReceiptPayload(raw, { verdict: fixture1.input.verdict });
  assert.equal(Buffer.byteLength(stableStringify(firstPayload)), fixture1.expected.payloadBytes);
  assert.equal(hashCanonicalReceiptPayload(firstPayload), fixture2.expected.payloadHash);
  assert.equal(Object.hasOwn(firstPayload, 'trustRoot'), false);
  assert.equal(Object.hasOwn(firstPayload, 'canonicalReceiptSchemaVersion'), false);
  assert.deepEqual(raw, rawBefore);

  const first = appendReceiptToChain(firstPayload);
  const secondPayload = v1(fixture3.input.successor);
  const second = appendReceiptToChain(secondPayload, first.receiptHash);
  assert.deepEqual(
    [first.receiptHash, second.receiptHash],
    [fixture3.expected.firstHash, fixture3.expected.secondHash],
  );
  const chainBefore = structuredClone([first, second]);
  assert.equal(validateReceiptChain([first, second]).valid, true);
  assert.equal(validateV4Chain([first, second]).valid, true);
  assert.deepEqual([first, second], chainBefore);

  const bundle = exportReceiptBundle([first, second], {
    workspaceId: fixture4.input.workspaceId,
    exportedAt: fixture4.input.exportedAt,
  });
  assert.equal(bundle.schemaVersion, 'v4-receipt-bundle-v1');
  assert.equal(Buffer.byteLength(stableStringify(bundle)), fixture4.expected.bundleBytes);
  assert.equal(sha256Hex(stableStringify(bundle)), fixture4.expected.bundleHash);
  const bundleBefore = structuredClone(bundle);
  assert.equal(verifyExportedBundle(bundle).valid, true);
  assert.deepEqual(bundle, bundleBefore);
});

test('V1 to V2 chronology succeeds without rewrite while downgrade and unsupported versions fail closed', () => {
  const first = appendReceiptToChain(v1());
  const firstBefore = structuredClone(first);
  const second = appendReceiptToChain(v2('local_operator', {
    receiptId: 'transition-v2-1',
    admissionId: 'transition-v2-a1',
    actor: 'external-name-must-not-authorize',
    metadata: { trustRoot: 'external_verified_client', signed: true },
  }), first.receiptHash);
  const third = appendReceiptToChain(v2('external_verified_client', {
    receiptId: 'transition-v2-2',
    admissionId: 'transition-v2-a2',
    actor: 'local-name-must-not-authorize',
    metadata: { trustRoot: 'local_operator', transport: 'local' },
  }), second.receiptHash);
  assert.equal(second.trustRoot, 'local_operator');
  assert.equal(third.trustRoot, 'external_verified_client');
  assert.equal(validateV4Chain([first, second, third]).valid, true);
  assert.deepEqual(first, firstBefore);

  const downgraded = appendReceiptToChain(v1({
    receiptId: 'freshly-rehashed-v1',
    admissionId: 'freshly-rehashed-v1-a',
  }), third.receiptHash);
  assert.equal(validateReceiptChain([first, second, third, downgraded]).valid, true);
  assert.equal(
    validateV4Chain([first, second, third, downgraded]).code,
    V4_RECEIPT_ERROR_CODES.CHAIN_VERSION_REGRESSION,
  );

  const unsupportedPayload = {
    ...v2('local_operator', {
      receiptId: 'unsupported-v99',
      admissionId: 'unsupported-v99-a',
    }),
    schemaVersion: 'v4-receipt-v99',
  };
  const unsupported = appendReceiptToChain(unsupportedPayload, third.receiptHash);
  assert.equal(validateReceiptChain([first, second, third, unsupported]).valid, true);
  assert.equal(
    validateV4Chain([first, second, third, unsupported]).code,
    V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
  );

  const generic = appendReceiptToChain({
    version: 'huqan.reviewed-external-graph-receipt.v1',
    receiptId: 'generic-non-v4',
  });
  assert.equal(validateReceiptChain([generic]).valid, true);
  assert.equal(classifyReceiptFamily(generic), 'non-v4');
  assert.equal(validateV4Chain([generic]).code, V4_RECEIPT_ERROR_CODES.BUNDLE_MIXED_FAMILY);
});

test('authority descriptor bypasses are rejected at canonical and materialized boundaries', () => {
  const canonicalCases = [];

  const missing = v2('local_operator');
  delete missing.trustRoot;
  canonicalCases.push(missing);

  const unknown = v2('local_operator');
  unknown.trustRoot = 'unknown';
  canonicalCases.push(unknown);

  const accessor = v2('local_operator');
  Object.defineProperty(accessor, 'trustRoot', { enumerable: true, get: () => 'local_operator' });
  canonicalCases.push(accessor);

  const hidden = v2('local_operator');
  Object.defineProperty(hidden, 'unexpected', { enumerable: false, value: true });
  canonicalCases.push(hidden);

  const symbolKey = v2('local_operator');
  Object.defineProperty(symbolKey, Symbol('authority'), { enumerable: false, value: true });
  canonicalCases.push(symbolKey);

  for (const candidate of canonicalCases) {
    assert.equal(validateCanonicalReceiptV2(candidate).valid, false);
  }

  const inherited = materializedV2(undefined);
  delete inherited.trustRoot;
  Object.setPrototypeOf(inherited, { trustRoot: 'local_operator' });

  const rawAccessor = materializedV2(undefined);
  Object.defineProperty(rawAccessor, 'trustRoot', { enumerable: true, get: () => 'local_operator' });

  const rawHidden = materializedV2('local_operator');
  Object.defineProperty(rawHidden, 'unexpected', { enumerable: false, value: true });

  const rawSymbol = materializedV2('local_operator');
  Object.defineProperty(rawSymbol, Symbol('authority'), { enumerable: false, value: true });

  const rawNested = materializedV2('local_operator', {
    metadata: { trustRoot: 'external_verified_client' },
  });

  for (const candidate of [inherited, rawAccessor, rawHidden, rawSymbol, rawNested]) {
    assert.equal(classifyRawMaterializedReceipt(candidate).kind, 'v2_invalid_trust_root');
  }
});

test('materialized readers fail without partial chains, preserve inputs and enforce workspace isolation', () => {
  const legacy = structuredClone(baseReceipt);
  const validV2 = materializedV2('local_operator', {
    receiptId: 'reader-v2-valid',
    admissionId: 'reader-v2-valid-a',
  });
  const invalidV2 = materializedV2(undefined, {
    receiptId: 'reader-v2-invalid',
    admissionId: 'reader-v2-invalid-a',
  });
  delete invalidV2.trustRoot;

  const events = [
    { workspaceId: legacy.workspaceId, details: { receipt: legacy } },
    { workspaceId: validV2.workspaceId, details: { receipt: validV2 } },
    { workspaceId: invalidV2.workspaceId, details: { receipt: invalidV2 } },
  ];
  const before = structuredClone(events);
  const chain = buildMaterializedReceiptChain(events, { workspaceId: legacy.workspaceId });
  assert.equal(chain.ok, false);
  assert.equal(chain.status, 'invalid');
  assert.deepEqual(chain.chain, []);
  assert.deepEqual(events, before);

  // The legacy receipt parses on its own, but it sits in the broken chain
  // asserted invalid just above, so the read is not an ordinary success: it
  // reports the integrity failure and marks the payload non-authoritative
  // (#766). The forensic copy is still returned, and still migrated.
  const legacyRead = readReceiptById(events, legacy.receiptId, { workspaceId: legacy.workspaceId });
  assert.equal(legacyRead.ok, false);
  assert.equal(legacyRead.status, 'chain_invalid');
  assert.equal(legacyRead.authoritative, false);
  assert.equal(legacyRead.canonicalPayload.schemaVersion, 'v4-receipt-v1');
  assert.equal(Object.hasOwn(legacyRead.canonicalPayload, 'trustRoot'), false);
  assert.deepEqual(events, before);

  const unsupported = {
    ...structuredClone(baseReceipt),
    receiptId: 'reader-unsupported',
    admissionId: 'reader-unsupported-a',
    canonicalReceiptSchemaVersion: 'v4-receipt-v99',
  };
  const unsupportedRead = readReceiptById([
    { workspaceId: unsupported.workspaceId, details: { receipt: unsupported } },
  ], unsupported.receiptId, { workspaceId: unsupported.workspaceId });
  assert.equal(unsupportedRead.ok, false);
  assert.equal(unsupportedRead.error.causeCode, V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);

  const foreign = {
    ...structuredClone(baseReceipt),
    receiptId: 'foreign-receipt',
    admissionId: 'foreign-a',
    workspaceId: 'foreign-workspace',
  };
  const isolated = readReceiptById([
    { workspaceId: foreign.workspaceId, details: { receipt: foreign } },
  ], foreign.receiptId, { workspaceId: 'workspace-fixed' });
  assert.equal(isolated.ok, false);
  assert.equal(isolated.status, 'not_found');
});

test('exports select exact versions, independently reject tamper and never mutate supplied artifacts', () => {
  const fixture4 = byId.get('RTR-004-V1-BUNDLE-BYTES');
  const first = appendReceiptToChain(v1());
  const secondV1 = appendReceiptToChain(v1(fixture4.input.successor), first.receiptHash);
  const v1Chain = [first, secondV1];
  const v1Before = structuredClone(v1Chain);
  const v1Bundle = exportReceiptBundle(v1Chain, {
    workspaceId: fixture4.input.workspaceId,
    exportedAt: fixture4.input.exportedAt,
  });
  assert.equal(v1Bundle.schemaVersion, 'v4-receipt-bundle-v1');
  assert.equal(sha256Hex(stableStringify(v1Bundle)), fixture4.expected.bundleHash);
  assert.deepEqual(v1Chain, v1Before);

  const secondV2 = appendReceiptToChain(v2('local_operator', {
    receiptId: 'export-v2',
    admissionId: 'export-v2-a',
  }), first.receiptHash);
  const v2Chain = [first, secondV2];
  const v2Before = structuredClone(v2Chain);
  const v2Bundle = exportReceiptBundle(v2Chain, { exportedAt: '2026-01-01T00:05:00.000Z' });
  assert.equal(v2Bundle.schemaVersion, 'v4-receipt-bundle-v2');
  assert.deepEqual(v2Chain, v2Before);
  const supplied = structuredClone(v2Bundle);
  const suppliedBefore = structuredClone(supplied);
  assert.equal(verifyExportedBundle(supplied).valid, true);
  assert.deepEqual(supplied, suppliedBefore);

  for (const mutate of [
    (bundle) => { bundle.schemaVersion = 'v4-receipt-bundle-v1'; },
    (bundle) => { bundle.receipts[1].trustRoot = 'unknown'; },
    (bundle) => { bundle.receipts[0].reason = 'rewritten'; },
    (bundle) => { bundle.receipts.reverse(); },
    (bundle) => { bundle.receipts[1].schemaVersion = 'v4-receipt-v99'; },
  ]) {
    const copy = structuredClone(v2Bundle);
    mutate(copy);
    assert.equal(verifyExportedBundle(copy).valid, false);
  }

  const generic = appendReceiptToChain({
    version: 'huqan.reviewed-external-graph-receipt.v1',
    receiptId: 'export-generic',
  });
  assert.equal(validateReceiptChain([generic]).valid, true);
  assert.throws(
    () => exportReceiptBundle([generic]),
    (error) => error?.code === V4_RECEIPT_ERROR_CODES.BUNDLE_MIXED_FAMILY,
  );
});

test('durable V4 V2 writing remains disabled with zero state and no replay residue', () => {
  const paths = pathsFor('v2-write-guard');
  const graph = new Graph({ ...paths, useSQLite: true });
  try {
    assert.throws(() => graph.runMutationOnce('rtr4-blocked-v2', () => {
      graph.addNode('rtr4-blocked-node', 'Blocked', null, { workspaceId: 'w' });
      return { changed: true };
    }, {
      buildCanonicalReceipt: () => v2('local_operator', {
        receiptId: 'rtr4-blocked-receipt',
        admissionId: 'rtr4-blocked-a',
        workspaceId: 'w',
      }),
    }), (error) => error?.code === V4_RECEIPT_ERROR_CODES.WRITE_NOT_ENABLED);

    assert.equal(graph.getNode('rtr4-blocked-node', 'w'), null);
    assert.equal(
      graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_journal WHERE operation_id = ?')
        .get('rtr4-blocked-v2').count,
      0,
    );
    assert.equal(
      graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count,
      0,
    );
    assert.equal(graph.getCommittedMutationReceiptByOperation('rtr4-blocked-v2'), null);

    const retry = graph.runMutationOnce('rtr4-blocked-v2', () => ({ changed: false }));
    assert.equal(retry.replayed, false);
  } finally {
    graph.close();
  }
});
