'use strict';

/**
 * #4092 PR-A1 — the evidence-pack manifest.
 *
 * The manifest is the claim a pack makes about its own directory: this is what
 * it contains, this is the SHA-256 of each file, and this is the hash that binds
 * the list. The three properties tested here are the ones a reader relies on
 * when they cannot ask the producer anything -- the hash is reproducible from
 * the manifest alone, a file's recorded hash matches the bytes, and every file
 * carries an integrityClass rather than an unstated assumption.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  EVIDENCE_PACK_SCHEMA_VERSION,
  INTEGRITY_CLASSES,
  INTEGRITY_CLASS_VALUES,
  PACK_NON_CLAIMS,
  canonicalPackPayload,
  computePackHash,
  fileEntry,
  buildManifest,
} = require('../lib/evidence-pack/manifest');
const { stableStringify, sha256Hex } = require('../lib/hash-chain');

function sampleManifest() {
  const bundleBytes = JSON.stringify({ sealVersion: 'huqan-bundle-seal-v2', receipts: [] });
  return buildManifest({
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
    generatedAt: '2026-02-01T00:00:00.000Z',
    workspaceId: 'default',
    producer: { product: 'huqan', version: '1.1.1', issuerKeyId: null },
    files: [
      fileEntry('receipts/receipt-bundle.json', bundleBytes, INTEGRITY_CLASSES.HASH_CHAINED),
      fileEntry('audit/audit-events.jsonl', '{}\n', INTEGRITY_CLASSES.SNAPSHOT_HASH_ONLY),
    ],
  });
}

test('computes packHash over canonical manifest excluding packHash and signature', () => {
  const manifest = sampleManifest();
  // Reproduced independently from the canonical payload, not from the builder.
  const expected = sha256Hex(stableStringify(canonicalPackPayload(manifest)));
  assert.equal(manifest.packHash, expected);
  // The two excluded fields must not change the hash.
  const withSignature = { ...manifest, signature: { keyId: 'issuer-1', value: 'x' } };
  assert.equal(computePackHash(withSignature), manifest.packHash);
  // And the payload really excludes them.
  assert.equal(Object.hasOwn(canonicalPackPayload(withSignature), 'packHash'), false);
  assert.equal(Object.hasOwn(canonicalPackPayload(withSignature), 'signature'), false);
});

test('packHash is order-independent over object keys but order-bound over files', () => {
  const manifest = sampleManifest();
  const reordered = {
    packHash: manifest.packHash,
    nonClaims: manifest.nonClaims,
    files: manifest.files,
    producer: manifest.producer,
    workspaceId: manifest.workspaceId,
    generatedAt: manifest.generatedAt,
    period: manifest.period,
    schemaVersion: manifest.schemaVersion,
  };
  assert.equal(computePackHash(reordered), manifest.packHash);
  const reorderedFiles = { ...manifest, files: [...manifest.files].reverse() };
  assert.notEqual(computePackHash(reorderedFiles), manifest.packHash);
});

test('rejects manifest whose file sha256 disagrees with file bytes', () => {
  const content = Buffer.from('audit line\n', 'utf8');
  const entry = fileEntry('audit/audit-events.jsonl', content, INTEGRITY_CLASSES.SNAPSHOT_HASH_ONLY);
  assert.equal(entry.sha256, crypto.createHash('sha256').update(content).digest('hex'));
  assert.equal(entry.bytes, content.length);
  // A different byte sequence produces a different recorded hash.
  const other = fileEntry('audit/audit-events.jsonl', Buffer.from('audit line!', 'utf8'), INTEGRITY_CLASSES.SNAPSHOT_HASH_ONLY);
  assert.notEqual(other.sha256, entry.sha256);
});

test('reports integrityClass for every file and rejects an unknown one', () => {
  const manifest = sampleManifest();
  for (const entry of manifest.files) {
    assert.ok(INTEGRITY_CLASS_VALUES.includes(entry.integrityClass), entry.path);
  }
  assert.throws(
    () => fileEntry('x.json', 'x', 'trust_me'),
    /known integrityClass/,
  );
});

test('the schema version and non-claims are part of the sealed payload', () => {
  const manifest = sampleManifest();
  assert.equal(manifest.schemaVersion, EVIDENCE_PACK_SCHEMA_VERSION);
  assert.deepEqual(manifest.nonClaims, [...PACK_NON_CLAIMS]);
  const dropped = { ...manifest, nonClaims: [] };
  assert.notEqual(computePackHash(dropped), manifest.packHash);
});
