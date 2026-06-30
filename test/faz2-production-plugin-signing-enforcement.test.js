const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const PluginManager = require('../plugin');

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function withPluginDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-faz2-pr7-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function pluginSource(name, capabilityName = `${name}Capability`) {
  return [
    'module.exports = {',
    `  name: ${JSON.stringify(name)},`,
    `  capabilities: [{ name: ${JSON.stringify(capabilityName)}, command: ${JSON.stringify(capabilityName)} }],`,
    '  run() { return { ok: true, source: "fixture" }; }',
    '};',
    '',
  ].join('\n');
}

function writePlugin(dir, name, opts = {}) {
  const filePath = path.join(dir, `${name}.js`);
  fs.writeFileSync(filePath, opts.source || pluginSource(name, opts.capabilityName));
  const manifestPath = filePath.replace(/\.js$/i, '.manifest.json');
  if (opts.manifest === 'missing') return { filePath, manifestPath };
  if (opts.manifest === 'malformed') {
    fs.writeFileSync(manifestPath, '{not-json');
    return { filePath, manifestPath };
  }
  const sha256 = PluginManager.hashFile(filePath);
  const manifest = opts.manifest || { sha256 };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  if (opts.tamperAfterManifest) {
    fs.appendFileSync(filePath, '\n// tampered\n');
  }
  return { filePath, manifestPath };
}

function loadFixture(dir, env = {}) {
  return withEnv(
    {
      NODE_ENV: 'production',
      AXIOM_PLUGIN_PRODUCTION_ENFORCEMENT: '1',
      AXIOM_PLUGIN_STRICT: undefined,
      AXIOM_PLUGIN_SIGNING_KEY: undefined,
      ...env,
    },
    () => {
      const manager = new PluginManager(null);
      const count = manager.load(dir);
      return { manager, count };
    }
  );
}

describe('FAZ2-7: production plugin signing/hash enforcement', () => {
  it('production/enforced mode rejects plugin with missing manifest', () => withPluginDir((dir) => {
    writePlugin(dir, 'missingPlugin', { manifest: 'missing', capabilityName: 'missingCap' });
    const { manager, count } = loadFixture(dir);

    assert.strictEqual(count, 0);
    assert.strictEqual(manager.getCapability('missingCap'), null);
  }));

  it('production/enforced mode rejects plugin with malformed manifest', () => withPluginDir((dir) => {
    writePlugin(dir, 'malformedPlugin', { manifest: 'malformed', capabilityName: 'malformedCap' });
    const { manager, count } = loadFixture(dir);

    assert.strictEqual(count, 0);
    assert.strictEqual(manager.getCapability('malformedCap'), null);
  }));

  it('production/enforced mode rejects plugin with hash mismatch', () => withPluginDir((dir) => {
    writePlugin(dir, 'hashMismatchPlugin', {
      manifest: { sha256: 'not-the-real-hash' },
      capabilityName: 'hashMismatchCap',
    });
    const { manager, count } = loadFixture(dir);

    assert.strictEqual(count, 0);
    assert.strictEqual(manager.getCapability('hashMismatchCap'), null);
  }));

  it('tampered plugin source does not register capability', () => withPluginDir((dir) => {
    writePlugin(dir, 'tamperedPlugin', {
      capabilityName: 'tamperedCap',
      tamperAfterManifest: true,
    });
    const { manager, count } = loadFixture(dir);

    assert.strictEqual(count, 0);
    assert.strictEqual(manager.getCapability('tamperedCap'), null);
  }));

  it('invalid plugin cannot execute through kernel.runCapability', async () => withPluginDir(async (dir) => {
    writePlugin(dir, 'blockedPlugin', {
      manifest: { sha256: 'bad-hash' },
      capabilityName: 'blockedCap',
    });

    await withEnv(
      {
        NODE_ENV: 'production',
        AXIOM_PLUGIN_PRODUCTION_ENFORCEMENT: '1',
        AXIOM_PLUGIN_STRICT: undefined,
        AXIOM_PLUGIN_SIGNING_KEY: undefined,
      },
      async () => {
        const kernel = new Kernel({
          noLoad: true,
          useSQLite: false,
          loadPlugins: false,
          capabilities: { pluginCapabilities: true },
        });
        const count = kernel.plugins.load(dir);

        assert.strictEqual(count, 0);
        await assert.rejects(
          () => kernel.runCapability('blockedCap', {}),
          /Unknown plugin capability: blockedCap/
        );
      }
    );
  }));

  it('valid hash-verified plugin loads and exposes expected capability', () => withPluginDir((dir) => {
    writePlugin(dir, 'validPlugin', { capabilityName: 'validCap' });
    const { manager, count } = loadFixture(dir);

    assert.strictEqual(count, 1);
    assert.ok(manager.getCapability('validCap'));
  }));

  it('production/enforced mode rejects direct unverified manual registration', () => withEnv(
    {
      NODE_ENV: 'production',
      AXIOM_PLUGIN_PRODUCTION_ENFORCEMENT: '1',
      AXIOM_PLUGIN_STRICT: undefined,
      AXIOM_PLUGIN_SIGNING_KEY: undefined,
    },
    () => {
      const manager = new PluginManager(null);
      assert.throws(
        () => manager.register({
          name: 'manualPlugin',
          capabilities: [{ name: 'manualCap' }],
          run() { return { ok: true }; },
        }),
        /verified production manifest/
      );
      assert.strictEqual(manager.getCapability('manualCap'), null);
    }
  ));

  it('dev/test direct registration remains explicit and compatible', () => withEnv(
    {
      NODE_ENV: 'test',
      AXIOM_PLUGIN_PRODUCTION_ENFORCEMENT: undefined,
      AXIOM_PLUGIN_STRICT: '0',
      AXIOM_PLUGIN_SIGNING_KEY: undefined,
    },
    () => {
      const manager = new PluginManager(null);
      manager.register({
        name: 'manualFixturePlugin',
        capabilities: [{ name: 'manualFixtureCap' }],
        run() { return { ok: true }; },
      });

      assert.ok(manager.getCapability('manualFixtureCap'));
    }
  ));

  it('no capability is registered before verification succeeds', () => withPluginDir((dir) => {
    const sideEffect = path.join(dir, 'loaded.flag');
    writePlugin(dir, 'sideEffectPlugin', {
      source: [
        'const fs = require("fs");',
        `fs.writeFileSync(${JSON.stringify(sideEffect)}, "loaded");`,
        ...pluginSource('sideEffectPlugin', 'sideEffectCap').split('\n'),
      ].join('\n'),
      manifest: { sha256: 'bad-hash' },
    });

    const { manager, count } = loadFixture(dir);

    assert.strictEqual(count, 0);
    assert.strictEqual(fs.existsSync(sideEffect), false, 'invalid plugin source must not be required');
    assert.strictEqual(manager.getCapability('sideEffectCap'), null);
  }));
});
