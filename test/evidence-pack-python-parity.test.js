'use strict';

/**
 * #4092 PR-A1 — the JS and Python verifiers must agree.
 *
 * Two implementations that disagree are worse than one: a reader cannot tell
 * which verdict to trust. So every fixture is run through both, and the test
 * compares the findings AND the exit status, not just the boolean. A verifier
 * that reported the right verdict with the wrong exit code would still be
 * unusable from a shell.
 *
 * The Python side is the shipped, standard-library-only verifier. It is invoked
 * as a process, exactly as an auditor would run it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const {
  INTEGRITY_CLASSES,
  fileEntry,
  buildManifest,
  computePackHash,
} = require('../lib/evidence-pack/manifest');
const { verifyPack, MANIFEST_FILE, BUNDLE_RELATIVE_PATH } = require('../lib/evidence-pack/verify');
const { exportReceiptBundle } = require('../lib/receipt/receipt-export');
const { signReceiptBundle } = require('../lib/receipt/signed-bundle');

const VERIFIER = path.join(__dirname, '..', 'specs', 'huqan-evidence-pack', '0.1', 'verify_pack.py');
const BUNDLE_BYTES = JSON.stringify(exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z' }));
const AUDIT_BYTES = '{"event":"gate.decision","decision":"allow"}\n';

function findPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []]]
    : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return { command, prefix };
  }
  return null;
}

function writePack(root) {
  fs.mkdirSync(path.join(root, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(root, BUNDLE_RELATIVE_PATH), BUNDLE_BYTES);
  fs.writeFileSync(path.join(root, 'audit/audit-events.jsonl'), AUDIT_BYTES);
  const manifest = buildManifest({
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
    generatedAt: '2026-02-01T00:00:00.000Z',
    workspaceId: 'default',
    producer: { product: 'huqan', version: '1.1.1', issuerKeyId: null },
    files: [
      fileEntry(BUNDLE_RELATIVE_PATH, BUNDLE_BYTES, INTEGRITY_CLASSES.HASH_CHAINED),
      fileEntry('audit/audit-events.jsonl', AUDIT_BYTES, INTEGRITY_CLASSES.SNAPSHOT_HASH_ONLY),
    ],
  });
  fs.writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

/** Each mutator turns a valid pack into a specific defect. */
const MUTATIONS = {
  'valid': () => {},
  'single-byte-change': (root) => {
    const bundlePath = path.join(root, BUNDLE_RELATIVE_PATH);
    const bytes = fs.readFileSync(bundlePath);
    const index = bytes.indexOf(Buffer.from('receipts'));
    bytes[index] = bytes[index] === 0x72 ? 0x73 : 0x72;
    fs.writeFileSync(bundlePath, bytes);
  },
  'removed-file': (root) => {
    fs.unlinkSync(path.join(root, 'audit/audit-events.jsonl'));
  },
  'unlisted-file': (root) => {
    fs.writeFileSync(path.join(root, 'receipts/stowaway.jsonl'), '{"not":"listed"}\n');
  },
  'tampered-manifest-hash': (root) => {
    const manifestPath = path.join(root, MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.packHash = 'a'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  },
  'invalid-bundle': (root) => {
    const broken = { ...JSON.parse(BUNDLE_BYTES), receiptCount: 9 };
    const brokenBytes = JSON.stringify(broken);
    fs.writeFileSync(path.join(root, BUNDLE_RELATIVE_PATH), brokenBytes);
    const manifestPath = path.join(root, MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files = manifest.files.map((entry) => (
      entry.path === BUNDLE_RELATIVE_PATH
        ? fileEntry(BUNDLE_RELATIVE_PATH, brokenBytes, INTEGRITY_CLASSES.HASH_CHAINED)
        : entry
    ));
    manifest.packHash = computePackHash(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  },
  'manifest-not-object': (root) => {
    fs.writeFileSync(path.join(root, MANIFEST_FILE), 'null');
  },
  'manifest-schema-version': (root) => {
    rewriteManifest(root, (manifest) => {
      manifest.schemaVersion = 'huqan.evidence-pack.v999';
    });
  },
  'manifest-path-traversal': (root) => {
    // A manifest entry that names a file outside the pack. A verifier that
    // resolved it would hash external bytes and could still report VALID.
    rewriteManifest(root, (manifest) => {
      manifest.files[0] = { path: '../outside.json', sha256: 'a'.repeat(64), bytes: 1, integrityClass: INTEGRITY_CLASSES.HASH_CHAINED };
    });
  },
  'manifest-non-normalized-path': (root) => {
    rewriteManifest(root, (manifest) => {
      manifest.files[0] = { path: 'audit/./audit-events.jsonl', sha256: 'a'.repeat(64), bytes: 1, integrityClass: INTEGRITY_CLASSES.HASH_CHAINED };
    });
  },
  'file-bytes-not-integer': (root) => {
    rewriteManifest(root, (manifest) => {
      manifest.files[0] = { ...manifest.files[0], bytes: 5.5 };
    });
  },
  'signed-bundle': (root) => {
    // A validly signed bundle. A structural pack check has no key resolver, so
    // it must ignore bundleSignature rather than judge the bundle invalid.
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = exportReceiptBundle([], {
      exportedAt: '2026-01-01T00:00:00.000Z',
      signing: { keyReference: 'registry:issuer-1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    });
    assert.ok(signed.bundleSignature);
    const signedBytes = JSON.stringify(signed);
    fs.writeFileSync(path.join(root, BUNDLE_RELATIVE_PATH), signedBytes);
    rewriteManifest(root, (manifest) => {
      manifest.files = manifest.files.map((entry) => (
        entry.path === BUNDLE_RELATIVE_PATH
          ? fileEntry(BUNDLE_RELATIVE_PATH, signedBytes, INTEGRITY_CLASSES.HASH_CHAINED)
          : entry
      ));
    });
  },
  'unlisted-symlink': (root) => {
    // A symlink is neither a regular file nor a directory; a verifier that
    // only pushed regular files would silently skip it.
    try {
      fs.symlinkSync('nonexistent-target.jsonl', path.join(root, 'receipts/link-out.jsonl'));
    } catch {
      return 'skip'; // some environments (Windows, unprivileged) forbid symlinks
    }
  },
};

function rewriteManifest(root, mutate) {
  const manifestPath = path.join(root, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  mutate(manifest);
  manifest.packHash = computePackHash(manifest);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

test('the python verifier and js verifier agree on valid and every tampered fixture including exit status', () => {
  const python = findPython();
  if (!python) return; // no interpreter available: the other tests still cover the JS side

  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-pack-${name}-`));
    try {
      writePack(root);
      if (mutate(root) === 'skip') continue;

      const jsResult = verifyPack(root);
      const run = spawnSync(python.command, [...python.prefix, VERIFIER, root], { encoding: 'utf8' });
      const expectedExit = jsResult.valid ? 0 : 1;
      assert.equal(run.status, expectedExit, `${name}: python exit ${run.status}, js valid=${jsResult.valid}\n${run.stdout}${run.stderr}`);

      const validLine = run.stdout.split('\n').find((line) => /\b(VALID|INVALID)\b/.test(line));
      assert.ok(validLine, `${name}: no verdict line\n${run.stdout}`);
      const pythonValid = /\bVALID\b/.test(validLine) && !/\bINVALID\b/.test(validLine);
      assert.equal(pythonValid, jsResult.valid, `${name}: python=${validLine.trim()} js=${JSON.stringify(jsResult.findings)}`);

      if (!jsResult.valid) {
        // Every JS finding must appear in the Python report, in the same set.
        const pythonFindings = validLine.split(/\bINVALID\b/)[1]
          .split(',').map((item) => item.trim()).filter(Boolean).sort();
        assert.deepEqual(pythonFindings, [...jsResult.findings].sort(), `${name}: findings disagree`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
