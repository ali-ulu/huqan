const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('Plugin manifest integrity', () => {
  const manifests = fs.readdirSync(PLUGINS_DIR)
    .filter(name => name.endsWith('.manifest.json'))
    .sort();

  it('has at least one plugin manifest to verify', () => {
    assert.ok(manifests.length > 0, 'expected at least one plugin manifest');
  });

  for (const manifestName of manifests) {
    it(`${manifestName} matches its plugin source bytes`, () => {
      const manifestPath = path.join(PLUGINS_DIR, manifestName);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const pluginName = manifestName.replace(/\.manifest\.json$/, '');
      const pluginPath = path.join(PLUGINS_DIR, `${pluginName}.js`);

      assert.ok(fs.existsSync(pluginPath), `${manifestName} has no matching ${pluginName}.js`);
      assert.match(manifest.sha256, /^[a-f0-9]{64}$/, `${manifestName} must declare a SHA-256 digest`);
      assert.strictEqual(
        sha256File(pluginPath),
        manifest.sha256,
        `${manifestName} SHA-256 does not match ${pluginName}.js bytes`
      );
    });
  }
});
