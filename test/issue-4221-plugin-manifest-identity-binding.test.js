'use strict';

/**
 * #4221: a plugin manifest signature must bind the manifest's identity fields,
 * not just the file hash.
 *
 * `issuer`, `version`, `workspaceId`, `capabilities` and `expiresAt` are
 * consumed as identity by the provenance registry and the supply-chain
 * activation gate. A signature over the content hash alone let an attacker
 * keep the bytes and the signature while rewriting the publisher, version,
 * workspace, capability list, or expiry -- and the loader would still report
 * `verified-signed`.
 *
 * The fix signs the file hash *and* every identity field, canonically. A
 * manifest with no identity fields keeps the exact hash-only signature it
 * always had, so no existing manifest moves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PluginManager = require('../plugin');

const KEY = ['issue', '4221', 'fixture', 'hmac', 'key'].join('-');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4221-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** Write a plugin file and a manifest, signing the given payload form. */
function writeManifest(dir, manifest, { signatureOver } = {}) {
  const filePath = path.join(dir, 'plugin.js');
  fs.writeFileSync(filePath, "module.exports = { name: 'plugin' };\n");
  const sha256 = PluginManager.hashFile(filePath);
  const record = { sha256, ...manifest };
  if (signatureOver === 'hash-only') {
    record.signature = PluginManager.hmacSign(sha256, KEY);
  } else if (signatureOver === 'bound') {
    record.signature = PluginManager.hmacSign(PluginManager.manifestSignaturePayload(record), KEY);
  }
  fs.writeFileSync(path.join(dir, 'plugin.manifest.json'), JSON.stringify(record));
  return filePath;
}

const IDENTITY = Object.freeze({
  version: '1.0.0',
  issuer: 'acme-trusted-publisher',
  workspaceId: 'workspace-a',
  capabilities: [{ name: 'acmeCap', command: 'acmeCap' }],
});

test('#4221: an identity-bearing manifest signed over the hash alone is not "verified-signed"', t => {
  const filePath = writeManifest(scratch(t), IDENTITY, { signatureOver: 'hash-only' });

  // Default (non-strict) mode: the honest status, not a false attestation.
  const relaxed = PluginManager.verifyPluginFile(filePath, { signatureKey: KEY });
  assert.equal(relaxed.status, 'verified-content-only',
    'a signature that does not cover the identity fields must not claim verified-signed');

  // Strict / production enforcement: fail closed.
  for (const opts of [{ signatureKey: KEY, strict: true }, { signatureKey: KEY, productionEnforcement: true }]) {
    const enforced = PluginManager.verifyPluginFile(filePath, opts);
    assert.equal(enforced.ok, false, `must reject under ${JSON.stringify(opts)}`);
    assert.equal(enforced.status, 'rejected');
  }
});

test('#4221: an identity-bearing manifest signed over the bound payload is verified-signed', t => {
  const filePath = writeManifest(scratch(t), IDENTITY, { signatureOver: 'bound' });
  const v = PluginManager.verifyPluginFile(filePath, { signatureKey: KEY, strict: true });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'verified-signed');
});

test('#4221: rewriting an identity field breaks a bound signature', t => {
  const dir = scratch(t);
  const filePath = writeManifest(dir, IDENTITY, { signatureOver: 'bound' });
  const manifestPath = path.join(dir, 'plugin.manifest.json');
  const signed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // The forgery the issue describes: keep the bytes and the signature, swap
  // the publisher (or version, workspace, capabilities, expiry).
  for (const edit of [
    { issuer: 'someone-else' },
    { version: '9.9.9' },
    { workspaceId: 'workspace-b' },
    { capabilities: [{ name: 'acmeCap', command: 'acmeCap' }, { name: 'net', command: 'net' }] },
    { expiresAt: '2030-01-01T00:00:00.000Z' },
  ]) {
    // Each case edits only its own field of the signed manifest.
    const tampered = { ...signed, ...edit };
    fs.writeFileSync(manifestPath, JSON.stringify(tampered));
    const v = PluginManager.verifyPluginFile(filePath, { signatureKey: KEY, strict: true });
    assert.equal(v.ok, false, `editing ${Object.keys(edit)[0]} must break the signature`);
    assert.equal(v.status, 'rejected');
  }
  fs.writeFileSync(manifestPath, JSON.stringify(signed));
  assert.equal(PluginManager.verifyPluginFile(filePath, { signatureKey: KEY, strict: true }).ok, true,
    'the untouched manifest still verifies, so each rejection came from its edit');
});

test('#4221: key order does not change the bound signature (canonical payload)', t => {
  const dir = scratch(t);
  const filePath = path.join(dir, 'plugin.js');
  fs.writeFileSync(filePath, "module.exports = { name: 'plugin' };\n");
  const sha256 = PluginManager.hashFile(filePath);
  const record = { sha256, ...IDENTITY };
  const signature = PluginManager.hmacSign(PluginManager.manifestSignaturePayload(record), KEY);
  // Same values, reversed key insertion order.
  const reordered = {};
  for (const key of Object.keys(record).reverse()) reordered[key] = record[key];
  reordered.signature = signature;
  fs.writeFileSync(path.join(dir, 'plugin.manifest.json'), JSON.stringify(reordered));

  const v = PluginManager.verifyPluginFile(filePath, { signatureKey: KEY, strict: true });
  assert.equal(v.ok, true, 'canonical serialization must ignore key order');
  assert.equal(v.status, 'verified-signed');
});

test('#4221: an identity-free manifest keeps the exact hash-only signature it always had', t => {
  const filePath = writeManifest(scratch(t), {}, { signatureOver: 'hash-only' });
  const v = PluginManager.verifyPluginFile(filePath, { signatureKey: KEY, strict: true });
  assert.equal(v.ok, true, 'nothing is unbound, so the legacy hash-only signature still verifies');
  assert.equal(v.status, 'verified-signed');
});
