'use strict';

/**
 * A shipped batch has to be checkable by whoever receives it (#1859).
 *
 * The guard writes its own receipts, so the machine that produced the evidence
 * is the machine the evidence is about. `contentHash` shows the bytes arrived
 * intact and lets a collector drop a duplicate; it proves nothing about who
 * sent them, because whoever edits the receipts recomputes it. These tests pin
 * the part that does: an ed25519 signature over the batch, and a collector that
 * reaches its own verdict about it rather than repeating the sender's claim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildReceiptBatch,
  readSigningKey,
  shipExternalActionReceipts,
} = require('../lib/external-action-receipt-shipper');
const {
  ingestReceiptBatch,
  queryFleet,
  readTrustedBatchKeys,
} = require('../lib/external-action-receipt-collector');
const { verifyReceiptBatchSignature } = require('../lib/receipt/signed-receipt-batch');

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

function receipt(id, decision = 'allow') {
  return {
    schemaVersion: 'v4-receipt-v1',
    receiptId: id,
    receiptKind: 'external_action_admission_receipt',
    decision,
    verdict: decision,
    workspaceId: TENANT.workspaceId,
    actor: 'demo-agent',
    createdAt: '2026-09-05T00:00:00.000Z',
    metadata: { identity: { identityRef: 'agent:default:demo-agent', agentId: 'demo-agent', ownerActorId: TENANT.ownerActorId, attested: false } },
  };
}

function signedBatch(keys, keyId = 'host-1') {
  return buildReceiptBatch({
    tenant: TENANT,
    receipts: [receipt('xact_1'), receipt('xact_2', 'block')],
    signingKey: { keyReference: keyId, privateKeyPem: keys.privateKeyPem },
  });
}

test('a signed batch verifies, and any edit to it stops verifying', () => {
  const keys = keyPair();
  const batch = signedBatch(keys);

  assert.equal(batch.bundleSignature.status, 'signed');
  assert.equal(batch.bundleSignature.algorithm, 'ed25519');
  assert.equal(batch.bundleSignature.keyId, 'host-1');
  assert.equal(verifyReceiptBatchSignature(batch, keys.publicKeyPem), true);

  // The edit that matters, and the one a count or a tenant field cannot catch:
  // same batch, same number of receipts, same tenant -- a block rewritten as an
  // allow. Only the content hash inside the signed payload sees this.
  const rewritten = {
    ...batch,
    receipts: batch.receipts.map(entry => (entry.decision === 'block' ? { ...entry, decision: 'allow', verdict: 'allow' } : entry)),
  };
  rewritten.contentHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(rewritten.receipts)).digest('hex')}`;
  assert.equal(rewritten.count, batch.count);
  assert.equal(verifyReceiptBatchSignature(rewritten, keys.publicKeyPem), false,
    'a rewritten decision must break the signature; the count is unchanged, so nothing else would catch it');

  // Dropping the blocked receipt entirely fails too.
  const censored = { ...batch, receipts: [batch.receipts[0]], count: 1 };
  censored.contentHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(censored.receipts)).digest('hex')}`;
  assert.equal(verifyReceiptBatchSignature(censored, keys.publicKeyPem), false);

  // Same receipts, another tenant: identity is covered too, so a batch cannot
  // be re-attributed.
  assert.equal(verifyReceiptBatchSignature({ ...batch, tenant: { workspaceId: 'default', ownerActorId: 'other' } }, keys.publicKeyPem), false);

  // A different key never verifies, however well-formed the envelope is.
  assert.equal(verifyReceiptBatchSignature(batch, keyPair().publicKeyPem), false);
});

test('an unsigned batch is stored and honestly marked, not silently trusted', t => {
  const store = scratch(t, 'huqan-collector-unsigned-');
  const batch = buildReceiptBatch({ tenant: TENANT, receipts: [receipt('xact_u1')] });
  assert.equal(batch.bundleSignature.status, 'unsigned');

  const result = ingestReceiptBatch({ batch, root: store });
  assert.equal(result.ok, true);
  assert.equal(result.signature.status, 'unsigned');

  const stored = JSON.parse(fs.readFileSync(path.join(store, 'default', 'acme', 'receipts.jsonl'), 'utf8').trim());
  assert.equal(stored.collector.bundleSignature, 'unsigned');
});

test('the collector reaches its own verdict instead of repeating the sender', t => {
  const store = scratch(t, 'huqan-collector-verdict-');
  const keys = keyPair();

  // Signed by a key this collector was never told to trust: storable, but not
  // evidence, and it must not be recorded as verified.
  const unknown = ingestReceiptBatch({ batch: signedBatch(keys), root: store });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.signature.status, 'unverified');
  assert.equal(unknown.signature.keyId, 'host-1');

  // Same signature, key now trusted.
  const verified = ingestReceiptBatch({ batch: signedBatch(keys), root: store, trustedKeys: { 'host-1': keys.publicKeyPem } });
  assert.equal(verified.signature.status, 'verified');

  const lines = fs.readFileSync(path.join(store, 'default', 'acme', 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([...new Set(lines.map(line => line.collector.bundleSignature))], ['unverified', 'verified']);
});

test('a batch that fails its own signature is refused, trusted keys or not', t => {
  const store = scratch(t, 'huqan-collector-tamper-');
  const keys = keyPair();
  const batch = signedBatch(keys);

  // The tamper an audit exists to catch: remove the block, keep the signature.
  const tampered = { ...batch, receipts: [batch.receipts[0]], count: 1 };
  tampered.contentHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(tampered.receipts)).digest('hex')}`;

  const refused = ingestReceiptBatch({ batch: tampered, root: store, trustedKeys: { 'host-1': keys.publicKeyPem } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'batch_signature_invalid');
  assert.equal(fs.existsSync(path.join(store, 'default', 'acme', 'receipts.jsonl')), false,
    'a contradicted batch must leave nothing in the trail');
});

test('a deployment can demand verified evidence and get a refusal without it', t => {
  const store = scratch(t, 'huqan-collector-required-');
  const keys = keyPair();

  const unsigned = ingestReceiptBatch({ batch: buildReceiptBatch({ tenant: TENANT, receipts: [receipt('xact_r1')] }), root: store, requireSignature: true });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.error.code, 'batch_signature_required');

  const untrusted = ingestReceiptBatch({ batch: signedBatch(keys), root: store, requireSignature: true });
  assert.equal(untrusted.ok, false, 'a key nobody vouched for is not evidence either');

  const accepted = ingestReceiptBatch({ batch: signedBatch(keys), root: store, requireSignature: true, trustedKeys: { 'host-1': keys.publicKeyPem } });
  assert.equal(accepted.ok, true);
});

test('the fleet view separates what was checked from what was merely stored', t => {
  const store = scratch(t, 'huqan-collector-fleet-');
  const keys = keyPair();
  ingestReceiptBatch({ batch: signedBatch(keys), root: store, trustedKeys: { 'host-1': keys.publicKeyPem } });
  ingestReceiptBatch({ batch: buildReceiptBatch({ tenant: TENANT, receipts: [receipt('xact_f1')] }), root: store });

  const fleet = queryFleet({ root: store });
  assert.equal(fleet.agents.length, 1);
  assert.deepEqual(fleet.agents[0].byBatchSignature, { verified: 2, unsigned: 1 });
});

test('a named signing key that cannot sign fails the run instead of shipping unsigned', t => {
  const base = scratch(t, 'huqan-signing-key-');
  const trail = path.join(base, 'receipts.jsonl');
  fs.writeFileSync(trail, `${JSON.stringify(receipt('xact_s1'))}\n`);

  const environment = { HUQAN_RECEIPT_SIGNING_KEY: path.join(base, 'missing.pem'), HUQAN_RECEIPT_SIGNING_KEY_ID: 'host-1' };
  assert.throws(() => readSigningKey({ environment }), /signing key is unreadable/);

  // Half a configuration is a mistake worth reporting, not a reason to ship
  // unsigned: an operator who set one variable believes signing is on.
  assert.throws(() => readSigningKey({ environment: { HUQAN_RECEIPT_SIGNING_KEY: path.join(base, 'k.pem') } }), /without HUQAN_RECEIPT_SIGNING_KEY_ID/);
  assert.throws(() => readSigningKey({ environment: { HUQAN_RECEIPT_SIGNING_KEY_ID: 'host-1' } }), /without HUQAN_RECEIPT_SIGNING_KEY/);
  assert.equal(readSigningKey({ environment: {} }), null, 'no key configured stays the supported case');

  const delivered = [];
  return shipExternalActionReceipts({
    path: trail,
    cursorPath: path.join(base, 'cursor.json'),
    environment,
    deliver: batch => { delivered.push(batch); return { ok: true }; },
  }).then(
    () => assert.fail('shipping should have failed on the unreadable key'),
    error => {
      assert.match(error.message, /signing key is unreadable/);
      assert.equal(delivered.length, 0, 'nothing may leave the host once signing was asked for and failed');
    },
  );
});

test('keys are trusted by file name, and an absent directory is no keys rather than a crash', t => {
  const base = scratch(t, 'huqan-trusted-keys-');
  const keys = keyPair();
  fs.writeFileSync(path.join(base, 'host-1.pem'), keys.publicKeyPem);
  fs.writeFileSync(path.join(base, 'host-2.pub'), keyPair().publicKeyPem);

  const loaded = readTrustedBatchKeys(base);
  assert.deepEqual(Object.keys(loaded).sort(), ['host-1', 'host-2']);
  assert.equal(loaded['host-1'], keys.publicKeyPem);

  assert.deepEqual(readTrustedBatchKeys(path.join(base, 'nope')), {});
  assert.deepEqual(readTrustedBatchKeys(''), {});
});
