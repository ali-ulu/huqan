'use strict';

/**
 * #4092 PR-A1 — independent evidence-pack verification.
 *
 * The verifier is the artifact an auditor runs, so what matters is what it
 * refuses: a single changed byte, a file the manifest lists but the directory
 * lacks, and a file the directory holds but the manifest does not claim. Each
 * test builds a real pack on disk and mutates it, because the property under
 * test is about bytes on a filesystem, not about an object in memory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  INTEGRITY_CLASSES,
  fileEntry,
  buildManifest,
} = require('../lib/evidence-pack/manifest');
const { verifyPack, MANIFEST_FILE, BUNDLE_RELATIVE_PATH } = require('../lib/evidence-pack/verify');
const { exportReceiptBundle } = require('../lib/receipt/receipt-export');
const { ledgerBytes } = require('./helpers/evidence-pack-fixtures');

const BUNDLE_BYTES = JSON.stringify(exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z' }));
const AUDIT_BYTES = '{"event":"gate.decision","decision":"allow"}\n';
const LEDGER_BYTES = ledgerBytes(3);

function writePack(root, extraFiles = {}) {
  fs.mkdirSync(path.join(root, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, 'emergency-stop'), { recursive: true });
  fs.writeFileSync(path.join(root, BUNDLE_RELATIVE_PATH), BUNDLE_BYTES);
  fs.writeFileSync(path.join(root, 'audit/audit-events.jsonl'), AUDIT_BYTES);
  fs.writeFileSync(path.join(root, 'emergency-stop/ledger.jsonl'), LEDGER_BYTES);
  for (const [relative, content] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  const manifest = buildManifest({
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
    generatedAt: '2026-02-01T00:00:00.000Z',
    workspaceId: 'default',
    producer: { product: 'huqan', version: '1.1.1', issuerKeyId: null },
    files: [
      fileEntry(BUNDLE_RELATIVE_PATH, BUNDLE_BYTES, INTEGRITY_CLASSES.HASH_CHAINED),
      fileEntry('emergency-stop/ledger.jsonl', LEDGER_BYTES, INTEGRITY_CLASSES.HASH_CHAINED),
      fileEntry('audit/audit-events.jsonl', AUDIT_BYTES, INTEGRITY_CLASSES.SNAPSHOT_HASH_ONLY),
    ],
  });
  fs.writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}

function withTempPack(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-evidence-pack-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('verifies a valid fixture pack', () => {
  withTempPack((root) => {
    writePack(root);
    const result = verifyPack(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.valid, true);
    assert.equal(result.files.length, 3);
    for (const file of result.files) {
      assert.ok(INTEGRITY_CLASSES && file.integrityClass, `${file.path} has no integrityClass`);
    }
    assert.ok(result.nonClaims.some((claim) => /not a SOC 2 report/.test(claim)));
  });
});

test('fails when any single byte of receipt-bundle.json changes', () => {
  withTempPack((root) => {
    writePack(root);
    const bundlePath = path.join(root, BUNDLE_RELATIVE_PATH);
    const bytes = fs.readFileSync(bundlePath);
    const index = bytes.indexOf(Buffer.from('receipts'));
    assert.ok(index >= 0);
    bytes[index] = bytes[index] === 0x72 ? 0x73 : 0x72;
    fs.writeFileSync(bundlePath, bytes);
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.startsWith('file_hash_mismatch:')));
  });
});

test('fails when a manifest file entry is removed', () => {
  withTempPack((root) => {
    const manifest = writePack(root);
    fs.unlinkSync(path.join(root, 'audit/audit-events.jsonl'));
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.ok(result.findings.includes('missing_file:audit/audit-events.jsonl'));
    assert.equal(manifest.files.length, 3);
  });
});

test('fails when an unlisted file is present', () => {
  withTempPack((root) => {
    writePack(root);
    fs.writeFileSync(path.join(root, 'receipts/stowaway.jsonl'), '{"not":"listed"}\n');
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.ok(result.findings.includes('unlisted_file:receipts/stowaway.jsonl'));
  });
});

test('fails when the manifest packHash is edited without the files', () => {
  withTempPack((root) => {
    writePack(root);
    const manifestPath = path.join(root, MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.packHash = 'f'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.ok(result.findings.includes('pack_hash_mismatch'));
  });
});

test('fails when the receipt bundle no longer passes the bundle checks', () => {
  withTempPack((root) => {
    // A bundle whose declared count disagrees with its receipts, sealed
    // consistently, so only the bundle check -- not the file hash -- catches it.
    const broken = JSON.parse(BUNDLE_BYTES);
    broken.receiptCount = 5;
    const brokenBytes = JSON.stringify(broken);
    writePack(root, { [BUNDLE_RELATIVE_PATH]: brokenBytes });
    const manifestPath = path.join(root, MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files[0] = fileEntry(BUNDLE_RELATIVE_PATH, brokenBytes, INTEGRITY_CLASSES.HASH_CHAINED);
    const { computePackHash } = require('../lib/evidence-pack/manifest');
    manifest.packHash = computePackHash(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.ok(result.findings.includes('receipt_bundle_invalid'));
  });
});

test('a pack with no manifest is INVALID rather than empty', () => {
  withTempPack((root) => {
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.startsWith('manifest_')));
  });
});

test('rejects a manifest entry whose path escapes the pack root', () => {
  withTempPack((root) => {
    const manifest = writePack(root);
    const manifestPath = path.join(root, MANIFEST_FILE);
    const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    onDisk.files[0] = { path: '../outside.json', sha256: 'a'.repeat(64), bytes: 1, integrityClass: INTEGRITY_CLASSES.SNAPSHOT_HASH_ONLY };
    const { computePackHash } = require('../lib/evidence-pack/manifest');
    onDisk.packHash = computePackHash(onDisk);
    fs.writeFileSync(manifestPath, JSON.stringify(onDisk, null, 2));
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.ok(result.findings.includes('manifest_path_invalid:../outside.json'));
    assert.equal(manifest.files.length, 3);
  });
});

test('reports a symlink in the pack directory as an unlisted file', () => {
  withTempPack((root) => {
    writePack(root);
    try {
      fs.symlinkSync('nonexistent-target.jsonl', path.join(root, 'receipts/link-out.jsonl'));
    } catch {
      return; // some environments forbid symlinks
    }
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.ok(result.findings.includes('unlisted_file:receipts/link-out.jsonl'));
  });
});

test('accepts a validly signed receipt bundle without a key resolver', () => {
  withTempPack((root) => {
    const crypto = require('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = exportReceiptBundle([], {
      exportedAt: '2026-01-01T00:00:00.000Z',
      signing: { keyReference: 'registry:issuer-1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    });
    assert.ok(signed.bundleSignature);
    const signedBytes = JSON.stringify(signed);
    writePack(root, { [BUNDLE_RELATIVE_PATH]: signedBytes });
    const manifestPath = path.join(root, MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files[0] = fileEntry(BUNDLE_RELATIVE_PATH, signedBytes, INTEGRITY_CLASSES.HASH_CHAINED);
    const { computePackHash } = require('../lib/evidence-pack/manifest');
    manifest.packHash = computePackHash(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = verifyPack(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.valid, true);
  });
});

const LEDGER_PATH = 'emergency-stop/ledger.jsonl';

function rewriteLedger(root, bytes) {
  fs.writeFileSync(path.join(root, LEDGER_PATH), bytes);
  const manifestPath = path.join(root, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files = manifest.files.map((entry) => (
    entry.path === LEDGER_PATH ? fileEntry(LEDGER_PATH, bytes, INTEGRITY_CLASSES.HASH_CHAINED) : entry
  ));
  const { computePackHash } = require('../lib/evidence-pack/manifest');
  manifest.packHash = computePackHash(manifest);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

test('fails when the emergency-stop ledger chain is broken even though the manifest was resealed', () => {
  withTempPack((root) => {
    writePack(root);
    // Edit one entry's reason and reseal the manifest: only the chain check can notice.
    const lines = ledgerBytes(3).split('\n');
    const entry = JSON.parse(lines[1]);
    entry.reason = 'rewritten after the fact';
    lines[1] = JSON.stringify(entry);
    rewriteLedger(root, lines.join('\n'));
    const result = verifyPack(root);
    assert.equal(result.valid, false);
    assert.deepEqual(result.findings, ['emergency_stop_ledger_invalid:ledger_hash_mismatch']);
  });
});

test('fails when an emergency-stop ledger entry is dropped from the middle', () => {
  withTempPack((root) => {
    writePack(root);
    const lines = ledgerBytes(3).split('\n');
    lines.splice(1, 1);
    rewriteLedger(root, lines.join('\n'));
    assert.deepEqual(verifyPack(root).findings, ['emergency_stop_ledger_invalid:ledger_seq_gap']);
  });
});

test('fails closed on an unparseable or non-object emergency-stop ledger line', () => {
  withTempPack((root) => {
    writePack(root);
    rewriteLedger(root, `${ledgerBytes(1)}null\n`);
    assert.deepEqual(verifyPack(root).findings, ['emergency_stop_ledger_invalid:ledger_unreadable_or_corrupt']);
    rewriteLedger(root, 'not json\n');
    assert.deepEqual(verifyPack(root).findings, ['emergency_stop_ledger_invalid:ledger_unreadable_or_corrupt']);
  });
});
