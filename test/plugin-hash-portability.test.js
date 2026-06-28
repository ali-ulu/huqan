const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PluginManager = require('../plugin');
const CLI = require('../cli');
const Kernel = require('../kernel');

// FAZ2-0C portability baseline: plugin manifest verification hashes the raw
// file bytes (crypto.createHash('sha256').update(fs.readFileSync(filePath))).
// That hash is byte-sensitive: on a CRLF checkout (e.g. Windows with
// core.autocrlf=true) the working-tree bytes of plugins/*.js change, the
// sha256 no longer matches plugins/*.manifest.json, idea-mri / company-brain
// are rejected at load, and getCapability('ideaMri') / getCapability(
// 'ingestStatus') return null -> CLI "Unknown plugin capability" + ingest 500.
//
// The fix is to enforce LF working-tree bytes for signed plugin files via
// .gitattributes (eol=lf). These tests guard that the signed bytes stay stable
// and that the affected capabilities remain available after loading. They do
// NOT weaken manifest verification or normalize line endings in the hash.
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const SIGNED_PLUGINS = ['idea-mri', 'company-brain'];

describe('Plugin hash portability (FAZ2-0C)', () => {
  for (const base of SIGNED_PLUGINS) {
    it(`${base}: working-tree bytes match the stored manifest sha256`, () => {
      const filePath = path.join(PLUGINS_DIR, `${base}.js`);
      const manifestPath = path.join(PLUGINS_DIR, `${base}.manifest.json`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const currentHash = PluginManager.hashFile(filePath);
      assert.strictEqual(
        currentHash,
        manifest.sha256,
        `${base}.js bytes do not match manifest sha256 (likely CRLF checkout / missing eol=lf)`
      );
    });

    it(`${base}.js has no CRLF line endings in the working tree`, () => {
      const raw = fs.readFileSync(path.join(PLUGINS_DIR, `${base}.js`));
      assert.ok(
        !raw.includes(Buffer.from('\r\n')),
        `${base}.js contains CRLF; signed plugin source must be LF (enforced via .gitattributes eol=lf)`
      );
    });
  }

  it('idea-mri and company-brain capabilities load and verify', () => {
    // Mirror the CLI/server harness: company-brain requires the graph and
    // companyMode capabilities, so it only registers under a real kernel.
    const cli = new CLI();
    cli.kernel = new Kernel({
      noLoad: true,
      capabilities: { pluginCapabilities: true, temporal: true, evidenceRanking: true, companyMode: true },
    });
    const count = cli.kernel.plugins.load(PLUGINS_DIR);
    assert.ok(count > 0, 'at least one plugin should load');

    const ideaMri = cli.kernel.plugins.getCapability('ideaMri');
    assert.ok(ideaMri, 'getCapability("ideaMri") must be available after loading');

    const ingestStatus = cli.kernel.plugins.getCapability('ingestStatus');
    assert.ok(ingestStatus, 'getCapability("ingestStatus") must be available after loading');
  });
});
