'use strict';

/**
 * Issuer seal emission on the live mutation path (#3188).
 *
 * The primitive, the key configuration and the write delegate were each tested
 * on their own; what was missing is proof that a *real* Graph mutation reaches
 * them. These tests drive `Graph.runMutationOnce` on both backends and read the
 * seal back through the public surface, because the failure this issue is about
 * is exactly the one unit tests cannot see: every piece works and nothing calls
 * them.
 *
 * The two properties that matter most are opposites:
 *
 *   - no key configured must change nothing at all, down to the receipt hash;
 *   - a configured key that cannot be honoured must fail before any mutation,
 *     or roll the whole thing back, never leave a half-written receipt.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, describe, test } = require('node:test');

const Graph = require('../graph');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { appendReceiptToChain } = require('../lib/receipt/receipt-chain');
const { verifyIssuerSeal, issuerKeyFingerprint } = require('../lib/receipt/issuer-seal');
const { readMutationJournal } = require('../lib/mutation-journal');
const { SEAL_TABLE } = require('../lib/graph-mutation-receipt-write');

const KEY_VAR = 'HUQAN_ISSUER_SEAL_KEY';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-issuer-emission-'));

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });

beforeEach(() => { delete process.env[KEY_VAR]; });

function writeKeyFile(name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = path.join(root, `${name}.pem`);
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return { file, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function payloadFor(receiptId, workspaceId = 'workspace-a') {
  return buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `madm_${receiptId}`,
    workspaceId,
    provenanceId: 'prov-1',
    trustPolicyVersion: '0.8.0',
    createdAt: '2026-09-09T01:00:00.000Z',
  }, { verdict: 'allow' });
}

function makeGraph(name, backend) {
  const opts = { memoryPath: path.join(root, `${name}-${backend}.json`) };
  if (backend === 'sqlite') opts.dbPath = path.join(root, `${name}-${backend}.db`);
  else opts.useSQLite = false;
  return new Graph(opts);
}

function mutateOnce(graph, operationId, receiptId) {
  return graph.runMutationOnce(operationId, () => {
    graph.addNode(`node-${operationId}`, 'sealed emission fixture');
    return { applied: true };
  }, { buildCanonicalReceipt: () => payloadFor(receiptId) });
}

describe('issuer seal emission — default off', () => {
  for (const backend of ['sqlite', 'json']) {
    test(`[${backend}] with no key configured the receipt is unsealed and unchanged`, () => {
      const graph = makeGraph('off', backend);
      const outcome = mutateOnce(graph, 'op-off', 'r-off');

      assert.ok(outcome.receipt?.receiptHash, 'a receipt must still be produced');
      assert.strictEqual(graph.getMutationReceiptSealByOperation('op-off'), null);
      assert.strictEqual(graph.getMutationReceiptSealByHash(outcome.receipt.receiptHash), null);

      // The hash is the one the chain would produce from the payload alone.
      const expected = appendReceiptToChain(outcome.receipt.canonicalPayload, null);
      assert.strictEqual(outcome.receipt.receiptHash, expected.receiptHash);
      // And no seal ever entered the hashed record.
      assert.ok(!Object.keys(outcome.receipt.canonicalPayload).some((key) => /seal|signature/i.test(key)));

      if (backend === 'sqlite') {
        assert.strictEqual(graph._db.prepare(`SELECT COUNT(*) c FROM ${SEAL_TABLE}`).get().c, 0);
      } else {
        const journal = readMutationJournal(graph.jsonJournalPath());
        assert.deepStrictEqual(Object.keys(journal.seals), []);
      }
      graph.closeSqlite?.();
    });
  }
});

describe('issuer seal emission — configured key', () => {
  for (const backend of ['sqlite', 'json']) {
    test(`[${backend}] a real mutation produces a verifiable seal keyed by receipt hash`, () => {
      const { file, publicKeyPem } = writeKeyFile(`emit-${backend}`);
      process.env[KEY_VAR] = file;
      const graph = makeGraph('on', backend);
      const outcome = mutateOnce(graph, 'op-on', 'r-on');

      const seal = graph.getMutationReceiptSealByOperation('op-on');
      assert.ok(seal, 'a configured key must seal the receipt');
      assert.strictEqual(seal.receiptHash, outcome.receipt.receiptHash);
      assert.strictEqual(seal.receiptId, outcome.receipt.receiptId);
      assert.strictEqual(verifyIssuerSeal(seal, publicKeyPem).ok, true);
      assert.strictEqual(graph.getMutationReceiptSealByHash(outcome.receipt.receiptHash).signature, seal.signature);

      // Sealing must not move the receipt hash: the seal is over the hash.
      const expected = appendReceiptToChain(outcome.receipt.canonicalPayload, null);
      assert.strictEqual(outcome.receipt.receiptHash, expected.receiptHash);
      assert.ok(!Object.keys(outcome.receipt.canonicalPayload).some((key) => /seal|signature/i.test(key)));
      graph.closeSqlite?.();
    });

    test(`[${backend}] the private key never reaches the journal or the receipt`, () => {
      const { file } = writeKeyFile(`secret-${backend}`);
      const privateKeyPem = fs.readFileSync(file, 'utf8');
      process.env[KEY_VAR] = file;
      const graph = makeGraph('secret', backend);
      mutateOnce(graph, 'op-secret', 'r-secret');

      const receiptText = JSON.stringify(graph.getCommittedMutationReceiptByOperation('op-secret'));
      const sealText = JSON.stringify(graph.getMutationReceiptSealByOperation('op-secret'));
      const onDisk = backend === 'sqlite'
        ? JSON.stringify(graph._db.prepare('SELECT * FROM mutation_receipts').all())
        : fs.readFileSync(graph.jsonJournalPath(), 'utf8');
      for (const text of [receiptText, sealText, onDisk]) {
        assert.ok(!text.includes(privateKeyPem), 'the private key must never be serialized');
        assert.ok(!/BEGIN PRIVATE KEY/.test(text));
      }
      graph.closeSqlite?.();
    });

    test(`[${backend}] a replay produces the same seal, not a different one`, () => {
      const { file, publicKeyPem } = writeKeyFile(`replay-${backend}`);
      process.env[KEY_VAR] = file;
      const graph = makeGraph('replay', backend);
      const first = mutateOnce(graph, 'op-replay', 'r-replay');
      const sealFirst = graph.getMutationReceiptSealByOperation('op-replay');
      const second = mutateOnce(graph, 'op-replay', 'r-replay');

      assert.strictEqual(second.replayed, true);
      assert.strictEqual(second.receipt.receiptHash, first.receipt.receiptHash);
      const sealSecond = graph.getMutationReceiptSealByOperation('op-replay');
      assert.deepStrictEqual(sealSecond, sealFirst);
      assert.strictEqual(verifyIssuerSeal(sealSecond, publicKeyPem).ok, true);
      graph.closeSqlite?.();
    });
  }
});

describe('issuer seal emission — failure is never silent', () => {
  test('an unusable key throws at composition time, before any mutation', () => {
    const file = path.join(root, 'not-a-key.pem');
    fs.writeFileSync(file, 'this is not a private key');
    process.env[KEY_VAR] = file;

    assert.throws(() => makeGraph('badkey', 'sqlite'), /issuer seal key/);
    // Nothing was opened, so no database was left behind to look half-written.
    assert.strictEqual(fs.existsSync(path.join(root, 'badkey-sqlite.db')), false);
  });

  test('an unreadable key path throws at composition time too', () => {
    process.env[KEY_VAR] = path.join(root, 'missing-issuer.pem');
    assert.throws(() => makeGraph('missingkey', 'sqlite'), /unreadable/);
  });

  for (const backend of ['sqlite', 'json']) {
    test(`[${backend}] a seal failure rolls back node, receipt and journal together`, () => {
      const { file } = writeKeyFile(`rollback-${backend}`);
      process.env[KEY_VAR] = file;
      const graph = makeGraph('rollback', backend);

      if (backend === 'sqlite') {
        // Removing the seal table makes the insert throw inside the outer
        // transaction -- the exact failure the rollback requirement is about.
        graph._db.exec(`DROP TABLE ${SEAL_TABLE}`);
      } else {
        // The JSON backend seals in memory before the journal is committed, so
        // the failure is injected where the seal is produced.
        const { sealChainedReceipt } = require('../lib/graph-mutation-receipt-write');
        void sealChainedReceipt;
        graph._issuerKey = { keyId: 'broken', privateKeyPem: 'not-a-key' };
      }

      assert.throws(() => mutateOnce(graph, 'op-rollback', 'r-rollback'));

      // No half-written receipt: neither the node, nor the receipt, nor a
      // completed journal entry may survive the failed mutation.
      assert.strictEqual(graph.getCommittedMutationReceiptByOperation('op-rollback'), null);
      assert.strictEqual(graph.getCommittedMutationResultByOperation('op-rollback'), null);
      if (backend === 'sqlite') {
        assert.strictEqual(graph._db.prepare('SELECT COUNT(*) c FROM nodes').get().c, 0);
        assert.strictEqual(graph._db.prepare('SELECT COUNT(*) c FROM mutation_receipts').get().c, 0);
      } else {
        assert.strictEqual(fs.existsSync(graph.memoryPath), false);
      }
      graph.closeSqlite?.();
    });
  }
});

describe('issuer seal emission — seals survive a restart', () => {
  test('a SQLite restart keeps the seal verifiable', () => {
    const { file, publicKeyPem } = writeKeyFile('restart');
    process.env[KEY_VAR] = file;
    const memoryPath = path.join(root, 'restart-sqlite.json');
    const dbPath = path.join(root, 'restart-sqlite.db');
    const first = new Graph({ memoryPath, dbPath });
    const outcome = mutateOnce(first, 'op-restart', 'r-restart');
    first.closeSqlite();

    const reopened = new Graph({ memoryPath, dbPath });
    const seal = reopened.getMutationReceiptSealByOperation('op-restart');
    assert.ok(seal, 'the seal must be readable after a restart');
    assert.strictEqual(seal.receiptHash, outcome.receipt.receiptHash);
    assert.strictEqual(verifyIssuerSeal(seal, publicKeyPem).ok, true);
    assert.strictEqual(reopened.getCommittedMutationReceiptByOperation('op-restart').receiptHash, outcome.receipt.receiptHash);
    reopened.closeSqlite();
  });

  test('a JSON reload keeps the seal verifiable', () => {
    const { file, publicKeyPem } = writeKeyFile('reload');
    process.env[KEY_VAR] = file;
    const memoryPath = path.join(root, 'reload-json.json');
    const first = new Graph({ memoryPath, useSQLite: false });
    const outcome = mutateOnce(first, 'op-reload', 'r-reload');

    // The journal is the JSON backend's authority, so a fresh Graph that only
    // reads it must still find the seal the previous instance wrote.
    const reloaded = new Graph({ memoryPath, useSQLite: false });
    const seal = reloaded.getMutationReceiptSealByOperation('op-reload');
    assert.ok(seal, 'the seal must survive a JSON reload');
    assert.strictEqual(seal.receiptHash, outcome.receipt.receiptHash);
    assert.strictEqual(verifyIssuerSeal(seal, publicKeyPem).ok, true);

    // And the key id on the seal is the fingerprint of the key that made it.
    assert.strictEqual(seal.keyId, issuerKeyFingerprint(publicKeyPem));
  });
});
