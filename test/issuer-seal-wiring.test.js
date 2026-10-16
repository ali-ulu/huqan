'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, test } = require('node:test');

const Database = require('better-sqlite3');
const { readIssuerSealKey } = require('../lib/issuer-seal-config');
const {
  SEAL_TABLE,
  ensureMutationReceiptSealSchema,
  sealChainedReceipt,
  writeChainedMutationReceipt,
} = require('../lib/graph-mutation-receipt-write');
const { verifyIssuerSeal, issuerKeyFingerprint } = require('../lib/receipt/issuer-seal');
const { appendReceiptToChain, validateReceiptChain } = require('../lib/receipt/receipt-chain');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-issuer-seal-'));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });

function writeKeyFile(name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = path.join(root, `${name}.pem`);
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return { file, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function payloadFor(receiptId) {
  return buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `madm_${receiptId}`,
    workspaceId: 'workspace-a',
    provenanceId: 'prov-1',
    trustPolicyVersion: '0.8.0',
    createdAt: '2026-09-09T01:00:00.000Z',
  }, { verdict: 'allow' });
}

function makeStore(db, issuerKey) {
  ensureMutationReceiptSealSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mutation_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      receipt_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      receipt_family TEXT NOT NULL,
      canonical_payload TEXT NOT NULL,
      previous_receipt_hash TEXT NOT NULL,
      receipt_hash TEXT NOT NULL UNIQUE,
      committed_at TEXT NOT NULL
    )
  `);
  const insertReceipt = db.prepare(`
    INSERT INTO mutation_receipts
      (operation_id, receipt_id, workspace_id, receipt_family, canonical_payload,
       previous_receipt_hash, receipt_hash, committed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSeal = db.prepare(`
    INSERT INTO ${SEAL_TABLE} (receipt_hash, receipt_id, workspace_id, key_id, seal, issued_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const latest = db.prepare(`
    SELECT receipt_hash FROM mutation_receipts
    WHERE workspace_id = ? AND receipt_family = ? ORDER BY sequence DESC LIMIT 1
  `);
  return {
    getLatestReceiptHash: (w, f) => latest.get(w, f)?.receipt_hash,
    insertReceipt: (...a) => insertReceipt.run(...a),
    insertSeal: (...a) => insertSeal.run(...a),
    now: () => '2026-09-09T01:00:00.000Z',
    productVersion: '0.12.0',
    issuerKey,
  };
}

describe('issuer seal config', () => {
  test('no variable means no key and no error', () => {
    assert.strictEqual(readIssuerSealKey({}), null);
  });

  test('a readable ed25519 key yields its derived fingerprint', () => {
    const { file, publicKeyPem } = writeKeyFile('good');
    const key = readIssuerSealKey({ HUQAN_ISSUER_SEAL_KEY: file });
    assert.strictEqual(key.keyId, issuerKeyFingerprint(publicKeyPem));
  });

  test('an unreadable path throws instead of silently not sealing', () => {
    assert.throws(
      () => readIssuerSealKey({ HUQAN_ISSUER_SEAL_KEY: path.join(root, 'missing.pem') }),
      /unreadable/,
    );
  });

  test('a wrong-algorithm key throws at configuration time, not on the write path', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const file = path.join(root, 'rsa.pem');
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    assert.throws(() => readIssuerSealKey({ HUQAN_ISSUER_SEAL_KEY: file }), /ed25519/);
  });
});

describe('sealing a chained receipt', () => {
  test('no key means no seal', () => {
    assert.strictEqual(sealChainedReceipt(appendReceiptToChain(payloadFor('r1'), null), null), null);
  });

  test('a configured key that cannot sign throws rather than committing unsealed', () => {
    const chained = appendReceiptToChain(payloadFor('r1'), null);
    assert.throws(
      () => sealChainedReceipt(chained, { privateKeyPem: 'not-a-key' }),
      /could not be produced/,
    );
  });

  test('the seal is bound to the receipt hash', () => {
    const { file, publicKeyPem } = writeKeyFile('bind');
    const key = readIssuerSealKey({ HUQAN_ISSUER_SEAL_KEY: file });
    const chained = appendReceiptToChain(payloadFor('r1'), null);
    const seal = sealChainedReceipt(chained, key, { issuedAt: '2026-09-09T01:00:00.000Z' });
    assert.strictEqual(seal.receiptHash, chained.receiptHash);
    assert.strictEqual(verifyIssuerSeal(seal, publicKeyPem).ok, true);
  });
});

describe('the write path', () => {
  test('with no key configured nothing is sealed and no seal row is written', () => {
    const db = new Database(':memory:');
    const store = makeStore(db, null);
    const { chained, seal } = writeChainedMutationReceipt(store, {
      operationId: 'op-1', payload: payloadFor('r1'), receiptFamily: 'v4',
    });
    assert.strictEqual(seal, null);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM ${SEAL_TABLE}`).get().c, 0);
    assert.ok(chained.receiptHash);
    db.close();
  });

  test('the receipt row is identical whether or not a key is configured', () => {
    const rows = [null, readIssuerSealKey({ HUQAN_ISSUER_SEAL_KEY: writeKeyFile('same').file })].map((key) => {
      const db = new Database(':memory:');
      writeChainedMutationReceipt(makeStore(db, key), {
        operationId: 'op-1', payload: payloadFor('r1'), receiptFamily: 'v4',
      });
      const row = db.prepare('SELECT * FROM mutation_receipts').get();
      db.close();
      return row;
    });
    assert.deepStrictEqual(rows[0], rows[1]);
  });

  test('a sealed write stores a verifiable seal keyed by receipt hash', () => {
    const { file, publicKeyPem } = writeKeyFile('stored');
    const db = new Database(':memory:');
    const { chained } = writeChainedMutationReceipt(
      makeStore(db, readIssuerSealKey({ HUQAN_ISSUER_SEAL_KEY: file })),
      { operationId: 'op-1', payload: payloadFor('r1'), receiptFamily: 'v4' },
    );
    const row = db.prepare(`SELECT * FROM ${SEAL_TABLE} WHERE receipt_hash = ?`).get(chained.receiptHash);
    assert.ok(row);
    assert.strictEqual(verifyIssuerSeal(JSON.parse(row.seal), publicKeyPem).ok, true);
    db.close();
  });

  test('the chain still validates when receipts are sealed', () => {
    const db = new Database(':memory:');
    const store = makeStore(db, readIssuerSealKey({ HUQAN_ISSUER_SEAL_KEY: writeKeyFile('chain').file }));
    const chain = ['r1', 'r2', 'r3'].map((id, i) => writeChainedMutationReceipt(store, {
      operationId: `op-${i}`, payload: payloadFor(id), receiptFamily: 'v4',
    }).chained);
    assert.strictEqual(validateReceiptChain(chain).valid, true);
    db.close();
  });

  test('the seal never enters the hashed record', () => {
    const db = new Database(':memory:');
    const store = makeStore(db, readIssuerSealKey({ HUQAN_ISSUER_SEAL_KEY: writeKeyFile('outside').file }));
    const { chained } = writeChainedMutationReceipt(store, {
      operationId: 'op-1', payload: payloadFor('r1'), receiptFamily: 'v4',
    });
    assert.strictEqual(chained.seal, undefined);
    assert.ok(!Object.keys(chained).some((k) => /seal|signature/i.test(k)));
    db.close();
  });

  test('the seal table is created idempotently', () => {
    const db = new Database(':memory:');
    ensureMutationReceiptSealSchema(db);
    ensureMutationReceiptSealSchema(db);
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(SEAL_TABLE));
    db.close();
  });
});
