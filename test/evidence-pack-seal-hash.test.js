'use strict';

/**
 * #4092 PR-A2, open question 1: does `mutation_receipt_seals.receipt_hash`
 * match the `receiptHash` the bounded receipt bundle shows?
 *
 * Characterization, run against the real learn path on both backends. The
 * answer is NO: the durable table chains each receipt family from its own
 * genesis over the canonical payload written at commit time, while the bundle
 * re-chains every materialized audit receipt from one genesis. So an issuer
 * seal cannot be found by the bundle's hash. The pack therefore finds the
 * durable receipt by `receiptId` and packs the seal exactly as stored, and it
 * does not claim the seal's hash equals the bundle's. If a later change makes
 * the two hashes agree, this test fails and the claim can be made.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKernel } = require('../lib/kernel-factory');
const { exportMaterializedReceiptBundleBounded } = require('../lib/receipt/bounded-receipt-export');
const { verifyIssuerSeal } = require('../lib/receipt/issuer-seal');
const { collectEvidencePack } = require('../lib/evidence-pack/collect');
const { verifyPack } = require('../lib/evidence-pack/verify');

const KEY_VAR = 'HUQAN_ISSUER_SEAL_KEY';

function sealedKernel(t, backend) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-a2-seal-${backend}-`));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(dir, 'issuer.pem');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const previous = process.env[KEY_VAR];
  process.env[KEY_VAR] = keyFile;
  const options = backend === 'sqlite'
    ? { memoryPath: path.join(dir, 'm.json'), dbPath: path.join(dir, 'm.db'), useSQLite: true }
    : { memoryPath: path.join(dir, 'm.json'), useSQLite: false };
  const kernel = createKernel(options);
  t.after(() => {
    if (previous === undefined) delete process.env[KEY_VAR]; else process.env[KEY_VAR] = previous;
    kernel.graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { kernel, dir, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

for (const backend of ['json', 'sqlite']) {
  test(`[${backend}] durable seal hash differs from the bundle receiptHash, and the pack packs the stored seal by receiptId`, async (t) => {
    const { kernel, dir, publicKeyPem } = sealedKernel(t, backend);
    const graph = kernel.graph;
    if (backend === 'sqlite' && !(graph._db && graph._stmts)) return t.skip('better-sqlite3 is unavailable');
    for (const text of ['dog is a mammal', 'cat is a mammal', 'fish is an animal']) kernel.learn(text, {});

    const exported = exportMaterializedReceiptBundleBounded(graph, { workspaceId: 'default' });
    assert.equal(exported.ok, true);
    assert.ok(exported.bundle.receipts.length >= 2, 'the learn path materialized receipts');

    const durableSeals = [];
    for (const packed of exported.bundle.receipts) {
      const durable = graph.getCommittedMutationReceiptById(packed.receiptId);
      assert.ok(durable, `durable receipt for ${packed.receiptId}`);
      // The characterization: the two hashes name different things.
      assert.notEqual(durable.receiptHash, packed.receiptHash);
      assert.equal(graph.getMutationReceiptSealByHash(packed.receiptHash), null);
      const seal = graph.getMutationReceiptSealByHash(durable.receiptHash);
      assert.ok(seal, 'the seal exists under the durable hash');
      assert.equal(seal.receiptId, packed.receiptId);
      assert.equal(verifyIssuerSeal(seal, publicKeyPem).ok, true);
      durableSeals.push(seal);
    }

    const outDir = path.join(dir, 'pack');
    collectEvidencePack({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
      outDir,
      graph,
      emergencyStopDir: path.join(dir, 'no-ledger'),
      externalReceiptsPath: path.join(dir, 'no-external.jsonl'),
      backupOptions: { backupBaseDir: path.join(dir, 'no-backups') },
    });
    const packed = fs.readFileSync(path.join(outDir, 'receipts', 'issuer-seals.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(packed, durableSeals);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.find((file) => file.path === 'receipts/issuer-seals.jsonl').integrityClass, 'issuer_sealed');
    assert.deepEqual(verifyPack(outDir).findings, []);
  });
}
