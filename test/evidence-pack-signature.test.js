'use strict';

/**
 * #4092 PR-A4 -- the pack manifest is signed with the issuer key the deployment
 * already has. Keys are generated at run time; nothing secret-looking is a literal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { INTEGRITY_CLASSES, fileEntry, buildManifest } = require('../lib/evidence-pack/manifest');
const { verifyPack, MANIFEST_FILE, SIGNATURE_FILE, BUNDLE_RELATIVE_PATH } = require('../lib/evidence-pack/verify');
const { issuerKeyIdOf, signPackManifest, verifyPackSignature, packSignaturePayload } = require('../lib/evidence-pack/signature');
const { exportReceiptBundle } = require('../lib/receipt/receipt-export');
const { signReceiptBundle, verifyReceiptBundleSignature } = require('../lib/receipt/signed-bundle');
const { issuerKeyFingerprint } = require('../lib/receipt/issuer-seal');
const { readIssuerSealKey } = require('../lib/issuer-seal-config');

const VERIFIER = path.join(__dirname, '..', 'specs', 'huqan-evidence-pack', '0.1', 'verify_pack.py');
const EXPORTED_AT = '2026-01-01T00:00:00.000Z';
const AUDIT_BYTES = '{"event":"gate.decision","decision":"allow"}\n';

const newKeyPem = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function findPython() {
  const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return { command, prefix };
  }
  return null;
}

function writePack(root, privateKeyPem, bundleBytes) {
  fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(root, 'audit/audit-events.jsonl'), AUDIT_BYTES);
  const files = [fileEntry('audit/audit-events.jsonl', AUDIT_BYTES, INTEGRITY_CLASSES.SNAPSHOT_HASH_ONLY)];
  if (bundleBytes) {
    fs.mkdirSync(path.join(root, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(root, BUNDLE_RELATIVE_PATH), bundleBytes);
    files.push(fileEntry(BUNDLE_RELATIVE_PATH, bundleBytes, INTEGRITY_CLASSES.HASH_CHAINED));
  }
  const manifest = buildManifest({
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
    generatedAt: '2026-02-01T00:00:00.000Z',
    workspaceId: 'default',
    producer: { product: 'huqan', version: '1.1.1', issuerKeyId: privateKeyPem ? issuerKeyIdOf(privateKeyPem) : null },
    files,
  });
  fs.writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  if (privateKeyPem) fs.writeFileSync(path.join(root, SIGNATURE_FILE), JSON.stringify(signPackManifest(manifest, privateKeyPem), null, 2));
  return manifest;
}

function tempPack(t, privateKeyPem, bundleBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = writePack(root, privateKeyPem, bundleBytes);
  return { root, manifest };
}

test('signs bundle with existing issuer key via signReceiptBundle v2', (t) => {
  const pem = newKeyPem();
  const keyId = issuerKeyIdOf(pem);
  const bundle = exportReceiptBundle([], { exportedAt: EXPORTED_AT, signing: { keyReference: keyId, privateKeyPem: pem } });
  assert.equal(bundle.bundleSignature.schemaVersion, 'huqan.receipt-bundle-signature.v2');
  const { root, manifest } = tempPack(t, pem, JSON.stringify(bundle));

  const verdict = verifyPack(root);
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.signature.signed, true);
  assert.equal(verdict.signature.keyId, keyId);
  assert.equal(manifest.producer.issuerKeyId, keyId);
  // One configured key signs both the bundle and the pack manifest.
  const envelope = JSON.parse(fs.readFileSync(path.join(root, SIGNATURE_FILE), 'utf8'));
  assert.ok(verifyReceiptBundleSignature(bundle, bundle.bundleSignature, envelope.publicKeyPem));
});

test('manifest signature verifies only with derived keyId', (t) => {
  const pem = newKeyPem();
  const { root, manifest } = tempPack(t, pem);
  assert.deepEqual(verifyPack(root).findings, []);

  const envelope = JSON.parse(fs.readFileSync(path.join(root, SIGNATURE_FILE), 'utf8'));
  assert.equal(envelope.keyId, issuerKeyFingerprint(envelope.publicKeyPem));
  assert.deepEqual(verifyPackSignature(manifest, envelope).findings, []);

  // A declared keyId that the public key does not derive to.
  const lied = { ...envelope, keyId: `ed25519:${'0'.repeat(32)}` };
  assert.ok(verifyPackSignature(manifest, lied).findings.includes('signature_key_id_mismatch'));
  // A different key signing the same payload under its own (self-consistent) keyId: producer key disagrees.
  const other = signPackManifest(manifest, newKeyPem());
  assert.deepEqual(verifyPackSignature(manifest, other).findings, ['signature_producer_key_mismatch']);
  // Right keyId, signature made by another key.
  const forged = { ...envelope, signature: other.signature };
  assert.deepEqual(verifyPackSignature(manifest, forged).findings, ['signature_invalid']);
});

test('signature over pack does not verify as receipt bundle signature (domain separation)', () => {
  const pem = newKeyPem();
  const bundle = exportReceiptBundle([], { exportedAt: EXPORTED_AT });
  const manifest = buildManifest({ period: { from: 'a', to: 'b' }, generatedAt: EXPORTED_AT, workspaceId: 'default', producer: { issuerKeyId: issuerKeyIdOf(pem) }, files: [] });
  const packSig = signPackManifest(manifest, pem);
  const publicKeyPem = packSig.publicKeyPem;

  for (const schemaVersion of ['huqan.receipt-bundle-signature.v1', 'huqan.receipt-bundle-signature.v2']) {
    assert.equal(verifyReceiptBundleSignature(bundle, { schemaVersion, algorithm: 'ed25519', signature: packSig.signature }, publicKeyPem), false);
  }
  // And the other way: a bundle signature is not a pack signature.
  const bundleSig = signReceiptBundle(bundle, { keyReference: 'k', privateKeyPem: pem });
  assert.deepEqual(verifyPackSignature(manifest, { ...packSig, signature: bundleSig.signature }).findings, ['signature_invalid']);
  assert.notEqual(packSignaturePayload(manifest).schemaVersion, bundleSig.schemaVersion);
});

test('no issuer key configured yields unsigned pack labelled unsigned not failure', (t) => {
  const { root } = tempPack(t, null);
  const verdict = verifyPack(root);
  assert.equal(verdict.valid, true);
  assert.deepEqual(verdict.signature, { signed: false, keyId: null });
  assert.equal(readIssuerSealKey({}), null);
});

test('a manifest naming an issuer key with its signature file removed is invalid', (t) => {
  const { root } = tempPack(t, newKeyPem());
  fs.unlinkSync(path.join(root, SIGNATURE_FILE));
  assert.deepEqual(verifyPack(root).findings, ['signature_missing']);
});

const SIGNED_TAMPERS = {
  'one-byte-audit': (root) => {
    const file = path.join(root, 'audit/audit-events.jsonl');
    const bytes = fs.readFileSync(file);
    bytes[2] ^= 1;
    fs.writeFileSync(file, bytes);
  },
  'signature-bit-flipped': (root) => {
    const file = path.join(root, SIGNATURE_FILE);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = Buffer.from(envelope.signature, 'base64');
    raw[10] ^= 1;
    fs.writeFileSync(file, JSON.stringify({ ...envelope, signature: raw.toString('base64') }));
  },
  'signature-swapped-key': (root) => {
    const file = path.join(root, SIGNATURE_FILE);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8'));
    fs.writeFileSync(file, JSON.stringify(signPackManifest(manifest, newKeyPem())));
  },
  'signature-not-json': (root) => fs.writeFileSync(path.join(root, SIGNATURE_FILE), 'nope'),
  'signature-removed': (root) => fs.unlinkSync(path.join(root, SIGNATURE_FILE)),
  'key-id-edited': (root) => {
    const file = path.join(root, SIGNATURE_FILE);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...envelope, keyId: `ed25519:${'1'.repeat(32)}` }));
  },
};

test('tampering with a signed pack is INVALID with the same verdict and exit status in both verifiers', (t) => {
  const python = findPython();
  if (!python) return t.skip('no python interpreter');
  const run = (root) => spawnSync(python.command, [...python.prefix, '-I', VERIFIER, root], { encoding: 'utf8' });

  const valid = tempPack(t, newKeyPem());
  const validRun = run(valid.root);
  assert.equal(validRun.status, 0, validRun.stdout + validRun.stderr);
  assert.match(validRun.stdout, /signature: signed {2}keyId: ed25519:[0-9a-f]{32}/);
  assert.match(validRun.stdout, /proves origin, not independence/);

  for (const [name, mutate] of Object.entries(SIGNED_TAMPERS)) {
    const { root } = tempPack(t, newKeyPem());
    mutate(root);
    const js = verifyPack(root);
    const py = run(root);
    assert.equal(js.valid, false, name);
    assert.equal(py.status, 1, `${name}\n${py.stdout}${py.stderr}`);
    const line = py.stdout.split('\n').find((l) => /\bINVALID\b/.test(l)) || '';
    const pyFindings = line.split(/\bINVALID\b/)[1].split(',').map((x) => x.trim()).filter(Boolean).sort();
    assert.deepEqual(pyFindings, [...js.findings].sort(), name);
  }
});

test('the python ed25519 verifier matches RFC 8032 test vector 1 and rejects a flipped bit', (t) => {
  const python = findPython();
  if (!python) return t.skip('no python interpreter');
  const code = [
    'import importlib.util,sys',
    'sys.dont_write_bytecode=True',
    'spec=importlib.util.spec_from_file_location("vp", sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'pk=bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")',
    'sig=bytes.fromhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")',
    'bad=bytes([sig[0]^1])+sig[1:]',
    'print(m.ed25519_verify(pk,sig,b""), m.ed25519_verify(pk,bad,b""), m.ed25519_verify(pk,sig,b"x"))',
  ].join('\n');
  const out = spawnSync(python.command, [...python.prefix, '-I', '-c', code, VERIFIER], { encoding: 'utf8' });
  assert.equal(out.stdout.trim(), 'True False False', out.stderr);
});

test('collectEvidencePack signs with the configured issuer key and seals the key id into packHash', (t) => {
  const { collectEvidencePack } = require('../lib/evidence-pack/collect');
  const Graph = require('../graph');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a4-collect-'));
  const graph = new Graph({ memoryPath: path.join(home, 'm.json'), dbPath: path.join(home, 'm.db'), useSQLite: true });
  t.after(() => {
    graph.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = {
    from: '2026-01-01', to: '2026-01-31', graph, emergencyStopDir: path.join(home, 'stops'),
    externalReceiptsPath: path.join(home, 'x.jsonl'), backupOptions: { backupBaseDir: path.join(home, 'b') },
  };
  const pem = newKeyPem();
  const signed = collectEvidencePack({ ...base, outDir: path.join(home, 'signed'), issuerKey: { keyId: 'ignored', privateKeyPem: pem } });
  assert.equal(signed.issuerKeyId, issuerKeyIdOf(pem));
  const verdict = verifyPack(signed.outDir);
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.signature.keyId, issuerKeyIdOf(pem));

  const unsigned = collectEvidencePack({ ...base, outDir: path.join(home, 'unsigned') });
  assert.equal(unsigned.issuerKeyId, null);
  assert.equal(fs.existsSync(path.join(unsigned.outDir, SIGNATURE_FILE)), false);
  assert.equal(verifyPack(unsigned.outDir).valid, true);
});
