'use strict';
/**
 * FAZ2-PR7 — Production Plugin Signing Enforcement.
 *
 * In production/enforced mode (strictPlugins = true, the default), a plugin that
 * is unsigned (missing manifest), has a malformed manifest, or whose source no
 * longer matches its manifest hash MUST fail closed: it does not load, does not
 * register capabilities, and cannot be executed through the kernel capability
 * path. Dev/test mode may stay permissive for a MISSING manifest, but a
 * malformed or tampered manifest fails closed in every mode.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PluginManager = require('../plugin');
const Kernel = require('../kernel');

// --- fixtures --------------------------------------------------------------

const VALID_PLUGIN_SRC =
  "module.exports = { name: 'fixturePlugin', " +
  "capabilities: [{ name: 'fixtureCap', command: 'fixture' }], " +
  "run(kernel, input) { return { ok: true, echo: input }; } };";

function tmpPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'faz2pr7-'));
}

function writePlugin(dir, fileName, src) {
  const pluginPath = path.join(dir, fileName);
  fs.writeFileSync(pluginPath, src, 'utf8');
  return pluginPath;
}

function writeManifestForCurrentBytes(pluginPath, extra = {}) {
  const manifestPath = pluginPath.replace(/\.js$/i, '.manifest.json');
  const sha256 = PluginManager.hashFile(pluginPath);
  fs.writeFileSync(manifestPath, JSON.stringify({ sha256, ...extra }), 'utf8');
  return { manifestPath, sha256 };
}

function enforcedManager(kernelOpts = {}) {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, ...kernelOpts });
  kernel.plugins.strictPlugins = true; // production / enforced mode
  return kernel;
}

// ---------------------------------------------------------------------------

describe('FAZ2-PR7: production plugin signing enforcement', () => {
  // 1. missing manifest -> rejected in enforced mode
  it('enforced mode rejects a plugin with a missing manifest', () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'no-manifest.js', VALID_PLUGIN_SRC);
    const verification = PluginManager.verifyPluginFile(pluginPath, { strict: true });
    assert.strictEqual(verification.ok, false, 'missing manifest must fail closed in enforced mode');
    assert.strictEqual(verification.status, 'rejected');
  });

  // 2. malformed manifest -> rejected (in EVERY mode)
  it('malformed manifest is rejected in enforced mode (no throw, fail closed)', () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'malformed.js', VALID_PLUGIN_SRC);
    fs.writeFileSync(pluginPath.replace(/\.js$/i, '.manifest.json'), '{ not: valid json ', 'utf8');
    const verification = PluginManager.verifyPluginFile(pluginPath, { strict: true });
    assert.strictEqual(verification.ok, false, 'malformed manifest must fail closed');
    assert.strictEqual(verification.status, 'rejected');
    assert.match(verification.reason, /malformed/i);
  });

  it('malformed manifest is also rejected in dev/test mode (never trusted)', () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'malformed-dev.js', VALID_PLUGIN_SRC);
    fs.writeFileSync(pluginPath.replace(/\.js$/i, '.manifest.json'), 'not json at all', 'utf8');
    const verification = PluginManager.verifyPluginFile(pluginPath, { strict: false });
    assert.strictEqual(verification.ok, false, 'malformed manifest must fail closed even in dev mode');
    assert.strictEqual(verification.status, 'rejected');
  });

  // 3. hash mismatch -> rejected
  it('enforced mode rejects a plugin whose source hash no longer matches its manifest', () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'mismatch.js', VALID_PLUGIN_SRC);
    writeManifestForCurrentBytes(pluginPath);
    // tamper the source AFTER the manifest was signed
    fs.writeFileSync(pluginPath, VALID_PLUGIN_SRC + '\n// tampered', 'utf8');
    const verification = PluginManager.verifyPluginFile(pluginPath, { strict: true });
    assert.strictEqual(verification.ok, false, 'hash mismatch must fail closed');
    assert.strictEqual(verification.status, 'rejected');
    assert.match(verification.reason, /hash mismatch/i);
  });

  // 4. tampered plugin source does not register a capability (via load)
  it('a tampered plugin does not load or register a capability in enforced mode', () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'tampered.js', VALID_PLUGIN_SRC);
    writeManifestForCurrentBytes(pluginPath);
    fs.writeFileSync(pluginPath, VALID_PLUGIN_SRC + '\n// evil', 'utf8');

    const kernel = enforcedManager();
    const loaded = kernel.plugins.load(dir);
    assert.strictEqual(loaded, 0, 'tampered plugin must not be counted as loaded');
    const caps = kernel.plugins.listCapabilities();
    assert.ok(!caps.some((c) => c.name === 'fixtureCap'),
      'tampered plugin capability must not appear in the capability list');
  });

  // 5. invalid plugin cannot execute through the kernel capability path
  it('a rejected plugin cannot be executed through kernel.runCapability', async () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'unexecutable.js', VALID_PLUGIN_SRC);
    writeManifestForCurrentBytes(pluginPath);
    fs.writeFileSync(pluginPath, VALID_PLUGIN_SRC + '\n// tamper', 'utf8');

    const kernel = enforcedManager();
    kernel.plugins.load(dir);
    kernel.enableCapability('pluginCapabilities');
    await assert.rejects(
      () => kernel.runCapability('fixtureCap', {}),
      /Unknown plugin capability/i,
      'a rejected plugin must not be reachable via kernel.runCapability'
    );
  });

  // 6. valid signed plugin still loads and exposes its capability
  it('a valid, hash-matching plugin loads and exposes its capability in enforced mode', async () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'valid.js', VALID_PLUGIN_SRC);
    writeManifestForCurrentBytes(pluginPath);

    const kernel = enforcedManager();
    const loaded = kernel.plugins.load(dir);
    assert.strictEqual(loaded, 1, 'valid plugin must load in enforced mode');
    const caps = kernel.plugins.listCapabilities();
    assert.ok(caps.some((c) => c.name === 'fixtureCap'), 'valid plugin capability must be registered');

    kernel.enableCapability('pluginCapabilities');
    const result = await kernel.runCapability('fixtureCap', { ping: 1 });
    assert.deepStrictEqual(result, { ok: true, echo: { ping: 1 } });
  });

  it('a valid HMAC-signed plugin verifies with the shared signing key', () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'signed.js', VALID_PLUGIN_SRC);
    const sha256 = PluginManager.hashFile(pluginPath);
    const signature = PluginManager.hmacSign(sha256, 'prod-signing-key');
    fs.writeFileSync(pluginPath.replace(/\.js$/i, '.manifest.json'),
      JSON.stringify({ sha256, signature }), 'utf8');

    const verification = PluginManager.verifyPluginFile(pluginPath, {
      strict: true,
      signatureKey: 'prod-signing-key',
    });
    assert.strictEqual(verification.ok, true);
    assert.strictEqual(verification.status, 'verified-signed');
  });

  it('a signed plugin with a wrong signature is rejected under a signing key', () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'badsig.js', VALID_PLUGIN_SRC);
    const sha256 = PluginManager.hashFile(pluginPath);
    fs.writeFileSync(pluginPath.replace(/\.js$/i, '.manifest.json'),
      JSON.stringify({ sha256, signature: 'deadbeef' }), 'utf8');

    const verification = PluginManager.verifyPluginFile(pluginPath, {
      strict: true,
      signatureKey: 'prod-signing-key',
    });
    assert.strictEqual(verification.ok, false);
    assert.match(verification.reason, /signature/i);
  });

  // 7. dev/test compatibility is explicit and does not weaken enforced mode
  it('dev/test mode may load a missing-manifest plugin, but enforced mode may not', () => {
    const dir = tmpPluginDir();
    const pluginPath = writePlugin(dir, 'unsigned.js', VALID_PLUGIN_SRC);

    const dev = PluginManager.verifyPluginFile(pluginPath, { strict: false });
    assert.strictEqual(dev.ok, true, 'dev mode is explicitly permissive for a missing manifest');
    assert.strictEqual(dev.status, 'unverified');

    const prod = PluginManager.verifyPluginFile(pluginPath, { strict: true });
    assert.strictEqual(prod.ok, false, 'enforced mode must not load an unsigned plugin');
  });

  it('the default PluginManager runs in enforced (strict) mode unless explicitly disabled', () => {
    const original = process.env.AXIOM_PLUGIN_STRICT;
    try {
      delete process.env.AXIOM_PLUGIN_STRICT;
      const k1 = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
      assert.strictEqual(k1.plugins.strictPlugins, true, 'default mode must be enforced (fail closed)');

      process.env.AXIOM_PLUGIN_STRICT = '0';
      const k2 = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
      assert.strictEqual(k2.plugins.strictPlugins, false, 'dev mode must be an explicit opt-out');
    } finally {
      if (original === undefined) delete process.env.AXIOM_PLUGIN_STRICT;
      else process.env.AXIOM_PLUGIN_STRICT = original;
    }
  });

  // 8. hash portability: the real signed production plugins still verify green
  it('all real production plugins verify against their committed manifests (no hash drift)', () => {
    const pluginsDir = path.join(__dirname, '..', 'plugins');
    const files = fs.readdirSync(pluginsDir).filter((f) => PluginManager.isRuntimePluginFile(f));
    assert.ok(files.length > 0, 'expected production plugins to exist');
    for (const file of files) {
      const verification = PluginManager.verifyPluginFile(path.join(pluginsDir, file), { strict: true });
      assert.strictEqual(verification.ok, true,
        `production plugin ${file} must verify in enforced mode (got: ${verification.reason})`);
    }
  });

  // 9. no capability is registered before verification succeeds
  it('in a mixed directory, only the verified plugin registers (invalid one is never exposed)', () => {
    const dir = tmpPluginDir();
    // valid plugin
    const validPath = writePlugin(dir, 'good.js', VALID_PLUGIN_SRC);
    writeManifestForCurrentBytes(validPath);
    // tampered plugin exposing a DIFFERENT capability name
    const evilSrc =
      "module.exports = { name: 'evilPlugin', " +
      "capabilities: [{ name: 'evilCap', command: 'evil' }], " +
      "run() { return { ok: true }; } };";
    const evilPath = writePlugin(dir, 'evil.js', evilSrc);
    writeManifestForCurrentBytes(evilPath);
    fs.writeFileSync(evilPath, evilSrc + '\n// tampered', 'utf8');

    const kernel = enforcedManager();
    const loaded = kernel.plugins.load(dir);
    assert.strictEqual(loaded, 1, 'only the verified plugin may load');
    const caps = kernel.plugins.listCapabilities().map((c) => c.name);
    assert.ok(caps.includes('fixtureCap'), 'verified plugin capability is registered');
    assert.ok(!caps.includes('evilCap'), 'tampered plugin capability must never be registered');
  });
});
