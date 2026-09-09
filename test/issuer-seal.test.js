const assert = require('assert');
const crypto = require('node:crypto');
const { describe, test } = require('node:test');

const {
  ISSUER_SEAL_VERSION,
  issuerKeyFingerprint,
  canonicalIssuerSealPayload,
  signIssuerSeal,
  verifyIssuerSeal,
} = require('../lib/receipt/issuer-seal');

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const RECEIPT = Object.freeze({
  receiptHash: 'a'.repeat(64),
  receiptId: 'madm_receipt_1',
  workspaceId: 'workspace-a',
  issuedAt: '2026-09-09T01:12:04.000Z',
  productVersion: '0.12.0',
});

describe('issuer seal: identity is derived, not declared', () => {
  test('a fingerprint is stable for the same key', () => {
    const { publicKeyPem } = keypair();
    assert.strictEqual(issuerKeyFingerprint(publicKeyPem), issuerKeyFingerprint(publicKeyPem));
  });

  test('different keys produce different fingerprints', () => {
    assert.notStrictEqual(
      issuerKeyFingerprint(keypair().publicKeyPem),
      issuerKeyFingerprint(keypair().publicKeyPem),
    );
  });

  test('the fingerprint names its algorithm', () => {
    assert.match(issuerKeyFingerprint(keypair().publicKeyPem), /^ed25519:[0-9a-f]{32}$/);
  });

  test('a non-ed25519 key has no issuer fingerprint', () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.strictEqual(issuerKeyFingerprint(publicKey.export({ type: 'spki', format: 'pem' }).toString()), '');
  });
});

describe('issuer seal: what it claims', () => {
  test('the payload says who issued it, never that the content is true', () => {
    const payload = canonicalIssuerSealPayload(RECEIPT);
    assert.strictEqual(payload.schemaVersion, ISSUER_SEAL_VERSION);
    assert.strictEqual(payload.issuedBy, 'huqan');
    const keys = Object.keys(payload);
    assert.ok(!keys.some((k) => /verified|trusted|certified|valid/i.test(k)));
  });

  test('it binds to the exact receipt bytes, not merely a receipt id', () => {
    const payload = canonicalIssuerSealPayload(RECEIPT);
    assert.strictEqual(payload.receiptHash, RECEIPT.receiptHash);
  });
});

describe('issuer seal: signing', () => {
  test('a sealed receipt verifies against the issuing key', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const seal = signIssuerSeal(RECEIPT, { privateKeyPem });
    assert.ok(seal);
    assert.strictEqual(verifyIssuerSeal(seal, publicKeyPem).ok, true);
  });

  test('the seal carries the fingerprint of the key that made it', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const seal = signIssuerSeal(RECEIPT, { privateKeyPem });
    assert.strictEqual(seal.keyId, issuerKeyFingerprint(publicKeyPem));
  });

  test('signing fails loudly rather than returning an unsealed-looking object', () => {
    assert.strictEqual(signIssuerSeal(RECEIPT, { privateKeyPem: 'not-a-key' }), null);
    assert.strictEqual(signIssuerSeal(RECEIPT, {}), null);
    assert.strictEqual(signIssuerSeal({ ...RECEIPT, receiptHash: '' }, { privateKeyPem: keypair().privateKeyPem }), null);
  });

  test('an rsa key cannot issue a seal', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    assert.strictEqual(signIssuerSeal(RECEIPT, { privateKeyPem: pem }), null);
  });
});

describe('issuer seal: it cannot be faked', () => {
  test('editing the receipt hash breaks the seal', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const seal = { ...signIssuerSeal(RECEIPT, { privateKeyPem }), receiptHash: 'b'.repeat(64) };
    const verdict = verifyIssuerSeal(seal, publicKeyPem);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, 'seal_hash_mismatch');
  });

  test('claiming another instance fingerprint breaks the seal', () => {
    const issuer = keypair();
    const other = keypair();
    const seal = { ...signIssuerSeal(RECEIPT, { privateKeyPem: issuer.privateKeyPem }), keyId: issuerKeyFingerprint(other.publicKeyPem) };
    const verdict = verifyIssuerSeal(seal, issuer.publicKeyPem);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, 'key_fingerprint_mismatch');
  });

  test('a seal lifted onto a different receipt does not verify', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const seal = signIssuerSeal(RECEIPT, { privateKeyPem });
    const lifted = { ...seal, receiptId: 'madm_receipt_2', receiptHash: 'c'.repeat(64) };
    assert.strictEqual(verifyIssuerSeal(lifted, publicKeyPem).ok, false);
  });

  test('a hand-written seal with no signature does not verify', () => {
    const { publicKeyPem } = keypair();
    const forged = { ...canonicalIssuerSealPayload(RECEIPT), keyId: 'ed25519:' + 'f'.repeat(32), algorithm: 'ed25519', signature: '' };
    assert.strictEqual(verifyIssuerSeal(forged, publicKeyPem).ok, false);
  });

  test('a signature made by another key does not verify', () => {
    const issuer = keypair();
    const attacker = keypair();
    const seal = signIssuerSeal(RECEIPT, { privateKeyPem: attacker.privateKeyPem });
    assert.strictEqual(verifyIssuerSeal(seal, issuer.publicKeyPem).ok, false);
  });

  // The check above is caught by the fingerprint comparison and never reaches
  // the signature. This one reaches it: same key, so keyId matches; payload
  // untouched, so sealHash matches; only the signature belongs to a different
  // statement. Without it, disabling signature verification entirely leaves the
  // suite green.
  test('a valid signature over a different receipt does not verify', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const sealForThis = signIssuerSeal(RECEIPT, { privateKeyPem });
    const sealForThat = signIssuerSeal({ ...RECEIPT, receiptHash: 'd'.repeat(64) }, { privateKeyPem });
    const swapped = { ...sealForThis, signature: sealForThat.signature };

    assert.strictEqual(swapped.keyId, sealForThis.keyId, 'fingerprint must still match');
    assert.strictEqual(swapped.sealHash, sealForThis.sealHash, 'seal hash must still match');
    const verdict = verifyIssuerSeal(swapped, publicKeyPem);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, 'signature_invalid');
  });

  test('verification recomputes the hash instead of trusting the stored one', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const seal = { ...signIssuerSeal(RECEIPT, { privateKeyPem }), sealHash: 'sha256:' + '0'.repeat(64) };
    assert.strictEqual(verifyIssuerSeal(seal, publicKeyPem).ok, false);
  });
});

describe('issuer seal: verification reports why, not just false', () => {
  test('a wrong schema version is named', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const seal = { ...signIssuerSeal(RECEIPT, { privateKeyPem }), schemaVersion: 'huqan.issuer-seal.v99' };
    assert.strictEqual(verifyIssuerSeal(seal, publicKeyPem).reason, 'unsupported_schema');
  });

  test('a missing public key is named', () => {
    const seal = signIssuerSeal(RECEIPT, { privateKeyPem: keypair().privateKeyPem });
    assert.strictEqual(verifyIssuerSeal(seal, '').reason, 'no_public_key');
  });
});
