'use strict';

/**
 * The collector's counter-seal (#1882).
 *
 * #1861 and #1863 prove where a receipt came from and that it did not change on
 * the way. Both signatures are made with keys on the audited host, so neither
 * answers the audit's real question: an operator holding that key can edit the
 * trail, re-sign it, and hand over a history where every signature verifies.
 *
 * What these pin is the part the operator cannot mint: a statement by the
 * receiving store, over what it was actually handed and when, chained so that
 * removing a batch afterwards leaves a break instead of a gap that looks like
 * a quiet week.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildReceiptBatch, shipExternalActionReceipts } = require('../lib/external-action-receipt-shipper');
const { ingestReceiptBatch, verifyCollectorSeals } = require('../lib/external-action-receipt-collector');
const { verifyCollectorSeal, verifyCollectorSealChain } = require('../lib/receipt/collector-seal');
const { readCollectorSealKey } = require('../lib/collector-seal-config');

const TENANT = Object.freeze({ workspaceId: 'default', ownerActorId: 'acme' });

function scratch(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return base;
}

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function receipt(id) {
  return {
    schemaVersion: 'v4-receipt-v1',
    receiptId: id,
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    verdict: 'allow',
    workspaceId: TENANT.workspaceId,
    actor: 'demo-agent',
    createdAt: '2026-09-05T00:00:00.000Z',
    metadata: { identity: { identityRef: 'agent:default:demo-agent', agentId: 'demo-agent', ownerActorId: TENANT.ownerActorId, attested: false } },
  };
}

function batchOf(ids) {
  return buildReceiptBatch({ tenant: TENANT, receipts: ids.map(receipt) });
}

function sealsIn(store) {
  return fs.readFileSync(path.join(store, 'default', 'acme', 'seals.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
}

test('the collector seals what it stored, over the content and not just the id', t => {
  const store = scratch(t, 'huqan-seal-basic-');
  const keys = keyPair();
  const batch = batchOf(['xact_1', 'xact_2']);

  const result = ingestReceiptBatch({
    batch,
    root: store,
    receivedAt: '2026-09-05T01:00:00.000Z',
    sealKey: { keyReference: 'collector-1', privateKeyPem: keys.privateKeyPem },
  });

  assert.equal(result.ok, true);
  assert.equal(result.seal.batchId, batch.batchId);
  assert.equal(result.seal.contentHash, batch.contentHash);
  assert.equal(result.seal.receivedAt, '2026-09-05T01:00:00.000Z');
  assert.equal(verifyCollectorSeal(result.seal, keys.publicKeyPem), true);

  // The seal is over the statement, so editing any part of it -- including the
  // arrival time a store might want to move -- stops it verifying.
  for (const edit of [{ receivedAt: '2026-01-01T00:00:00.000Z' }, { contentHash: 'sha256:0' }, { count: 99 }]) {
    assert.equal(verifyCollectorSeal({ ...result.seal, ...edit }, keys.publicKeyPem), false,
      `editing ${Object.keys(edit)[0]} must break the seal`);
  }
  assert.equal(verifyCollectorSeal(result.seal, keyPair().publicKeyPem), false);
});

test('seals chain, so a removed batch is a break rather than a gap', t => {
  const store = scratch(t, 'huqan-seal-chain-');
  const keys = keyPair();
  const sealKey = { keyReference: 'collector-1', privateKeyPem: keys.privateKeyPem };
  const trustedKeys = { 'collector-1': keys.publicKeyPem };

  for (const ids of [['xact_1'], ['xact_2'], ['xact_3']]) {
    ingestReceiptBatch({ batch: batchOf(ids), root: store, sealKey });
  }

  const seals = sealsIn(store);
  assert.equal(seals.length, 3);
  assert.equal(seals[0].previousSealHash, '');
  assert.equal(seals[1].previousSealHash, seals[0].sealHash);
  assert.equal(seals[2].previousSealHash, seals[1].sealHash);
  assert.equal(verifyCollectorSealChain(seals, trustedKeys).ok, true);

  // The deletion this exists to expose: drop the middle batch. Every remaining
  // seal is individually valid, which is exactly why the chain has to be the
  // thing that is checked.
  const withoutMiddle = [seals[0], seals[2]];
  assert.equal(verifyCollectorSeal(withoutMiddle[1], keys.publicKeyPem), true);
  const broken = verifyCollectorSealChain(withoutMiddle, trustedKeys);
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'seal_chain_broken');
  assert.equal(broken.index, 1);
});

test('the store audit reports unsealed and broken as different answers', t => {
  const store = scratch(t, 'huqan-seal-audit-');
  const keys = keyPair();
  const trustedKeys = { 'collector-1': keys.publicKeyPem };

  // A tenant nobody sealed must never read as passing.
  ingestReceiptBatch({ batch: batchOf(['xact_u']), root: store });
  const unsealed = verifyCollectorSeals({ root: store, trustedKeys });
  assert.equal(unsealed.ok, true, 'unsealed is not a failure, it is a different claim');
  assert.equal(unsealed.tenants[0].status, 'unsealed');

  const sealed = scratch(t, 'huqan-seal-audit-ok-');
  for (const ids of [['xact_1'], ['xact_2']]) {
    ingestReceiptBatch({ batch: batchOf(ids), root: sealed, sealKey: { keyReference: 'collector-1', privateKeyPem: keys.privateKeyPem } });
  }
  const verified = verifyCollectorSeals({ root: sealed, trustedKeys });
  assert.equal(verified.ok, true);
  assert.equal(verified.tenants[0].status, 'verified');
  assert.equal(verified.tenants[0].sealed, 2);

  // Rewrite the file with the first seal removed: the store now claims a
  // history it was not handed.
  const remaining = sealsIn(sealed).slice(1);
  fs.writeFileSync(path.join(sealed, 'default', 'acme', 'seals.jsonl'), `${remaining.map(seal => JSON.stringify(seal)).join('\n')}\n`);
  const audit = verifyCollectorSeals({ root: sealed, trustedKeys });
  assert.equal(audit.ok, false);
  assert.equal(audit.tenants[0].status, 'broken');
  assert.equal(audit.tenants[0].reason, 'seal_chain_broken');

  // A key nobody vouched for cannot be used to bless the chain either.
  assert.equal(verifyCollectorSeals({ root: sealed, trustedKeys: {} }).tenants[0].reason, 'seal_key_not_trusted');
});

test('a collector asked to seal refuses to store unsealed', t => {
  const store = scratch(t, 'huqan-seal-failclosed-');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  const refused = ingestReceiptBatch({
    batch: batchOf(['xact_1']),
    root: store,
    // Right shape, wrong algorithm: the seal cannot be made.
    sealKey: { keyReference: 'collector-1', privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'collector_seal_failed');
});

test('the shipper keeps the seal it got back, because it cannot mint one', t => {
  const base = scratch(t, 'huqan-seal-shipper-');
  const store = path.join(base, 'store');
  const keys = keyPair();
  const trail = path.join(base, 'receipts.jsonl');
  fs.writeFileSync(trail, `${[receipt('xact_1'), receipt('xact_2')].map(entry => JSON.stringify(entry)).join('\n')}\n`);

  return shipExternalActionReceipts({
    path: trail,
    cursorPath: path.join(base, 'cursor.json'),
    deliver: batch => ingestReceiptBatch({
      batch,
      root: store,
      sealKey: { keyReference: 'collector-1', privateKeyPem: keys.privateKeyPem },
    }),
  }).then(report => {
    assert.equal(report.shipped, 2);
    assert.equal(report.sealed, 1, 'one batch, one seal');

    const held = fs.readFileSync(`${trail}.seals.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(held.length, 1);
    assert.equal(verifyCollectorSeal(held[0], keys.publicKeyPem), true,
      'the host now holds proof the collector took this batch, which it could not produce itself');
  });
});

test('a collector that is not sealing reports zero seals rather than pretending', t => {
  const base = scratch(t, 'huqan-seal-absent-');
  const trail = path.join(base, 'receipts.jsonl');
  fs.writeFileSync(trail, `${JSON.stringify(receipt('xact_1'))}\n`);

  return shipExternalActionReceipts({
    path: trail,
    cursorPath: path.join(base, 'cursor.json'),
    deliver: batch => ingestReceiptBatch({ batch, root: path.join(base, 'store') }),
  }).then(report => {
    assert.equal(report.shipped, 1);
    assert.equal(report.sealed, 0);
    assert.equal(fs.existsSync(`${trail}.seals.jsonl`), false);
  });
});

test('half a seal configuration fails instead of quietly not sealing', t => {
  const base = scratch(t, 'huqan-seal-config-');
  assert.equal(readCollectorSealKey({}), null, 'no configuration stays the supported case');
  assert.throws(() => readCollectorSealKey({ HUQAN_COLLECTOR_SEAL_KEY: path.join(base, 'k.pem') }), /without HUQAN_COLLECTOR_SEAL_KEY_ID/);
  assert.throws(() => readCollectorSealKey({ HUQAN_COLLECTOR_SEAL_KEY_ID: 'collector-1' }), /without HUQAN_COLLECTOR_SEAL_KEY/);
  assert.throws(() => readCollectorSealKey({
    HUQAN_COLLECTOR_SEAL_KEY: path.join(base, 'missing.pem'),
    HUQAN_COLLECTOR_SEAL_KEY_ID: 'collector-1',
  }), /seal key is unreadable/);
});
