const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PluginManager = require('../plugin');

// FAZ 0 finding F-01: the plugin loader filtered files with `f.endsWith('.js')`,
// which also matched `*.test.js`. Those files were require()d as plugins, so their
// top-level node:test calls executed inside the production server/CLI process and
// injected into whatever test suite was running. The loader must never treat a
// test file as a runtime plugin.
describe('Plugin loader test-file exclusion (F-01)', () => {
  it('isRuntimePluginFile rejects .test.js / .spec.js and accepts plain .js', () => {
    assert.strictEqual(PluginManager.isRuntimePluginFile('repo-memory.test.js'), false);
    assert.strictEqual(PluginManager.isRuntimePluginFile('foo.spec.js'), false);
    assert.strictEqual(PluginManager.isRuntimePluginFile('valid-plugin.js'), true);
    assert.strictEqual(PluginManager.isRuntimePluginFile('notes.md'), false);
  });

  it('load() never require()s *.test.js files (no test-code side effect)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-plugin-loader-'));
    const sideEffectFile = path.join(dir, 'side-effect.flag');
    try {
      // Boundary: a valid package.json at the fixture root stops Node's package
      // config resolution from walking up into a possibly broken parent temp
      // package.json (avoids the Windows "Invalid package config" flakiness when
      // os.tmpdir() contains a malformed package.json).
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));

      // A real runtime plugin (with manifest, since strict mode is default ON).
      const validPath = path.join(dir, 'valid-plugin.js');
      fs.writeFileSync(validPath, "module.exports = { name: 'valid-fixture-plugin' };\n");
      const validSha = PluginManager.hashFile(validPath);
      fs.writeFileSync(validPath.replace(/\.js$/i, '.manifest.json'), JSON.stringify({ sha256: validSha }));

      // A test file that writes a side-effect flag the moment it is require()d.
      // It also carries a valid manifest, so the ONLY thing keeping it out of the
      // runtime is the loader's file-name predicate — exactly what we are testing.
      const testPath = path.join(dir, 'fake-plugin.test.js');
      fs.writeFileSync(
        testPath,
        `const fs = require('fs');\nfs.writeFileSync(${JSON.stringify(sideEffectFile)}, 'loaded');\nmodule.exports = { name: 'should-not-load' };\n`
      );
      const testSha = PluginManager.hashFile(testPath);
      fs.writeFileSync(testPath.replace(/\.js$/i, '.manifest.json'), JSON.stringify({ sha256: testSha }));

      const pm = new PluginManager(null);
      const count = pm.load(dir);

      assert.strictEqual(fs.existsSync(sideEffectFile), false, '.test.js file must not be require()d');
      assert.ok(pm.plugins.some(p => p.name === 'valid-fixture-plugin'), 'valid plugin should load');
      assert.ok(!pm.plugins.some(p => p.name === 'should-not-load'), 'test file must not register as a plugin');
      assert.strictEqual(count, 1, 'only the valid plugin should be counted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
