const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PluginManager = require('../plugin');
const { createActivationGate } = require('../lib/supply-chain-activation-gate');

const hash = 'a'.repeat(64);
const component = { componentType: 'plugin', name: 'safe-plugin', version: '1.0.0', contentHash: hash, issuer: 'operator', workspaceId: 'workspace-a', capabilities: ['safe.run'] };

async function withEnv(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value; return await fn(); }
  finally { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

describe('supply-chain activation gate', () => {
  it('requires the exact allowlisted type/name/version/hash/issuer/workspace/capabilities', () => {
    const gate = createActivationGate({ components: [component] });
    assert.strictEqual(gate.activate(component).receipt.decision, 'allow');
    assert.throws(() => gate.activate({ ...component, capabilities: ['other.run'] }), /not-allowlisted/);
    assert.throws(() => gate.activate({ ...component, contentHash: 'b'.repeat(64) }), /not-allowlisted/);
  });

  it('expires and revokes one exact component without affecting another workspace', () => {
    const expiring = { ...component, expiresAt: '2020-01-01T00:00:00.000Z' };
    const otherWorkspace = { ...component, workspaceId: 'workspace-b' };
    const gate = createActivationGate({ components: [component, expiring, otherWorkspace] }, { now: () => new Date('2026-08-24T00:00:00.000Z') });
    assert.throws(() => gate.activate(expiring), /expired/);
    gate.revoke(component, 'incident-42');
    assert.throws(() => gate.reattest(component), /incident-42/);
    assert.strictEqual(gate.activate(otherWorkspace).ok, true);
  });

  it('reattests plugin bytes immediately before capability execution', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-activation-'));
    try {
      const source = 'module.exports={name:"safe-plugin",capabilities:[{name:"safe.run"}],run(){return "ok"}};\n';
      const file = path.join(dir, 'safe-plugin.js');
      fs.writeFileSync(file, source);
      const contentHash = crypto.createHash('sha256').update(source).digest('hex');
      fs.writeFileSync(path.join(dir, 'safe-plugin.manifest.json'), JSON.stringify({ sha256: contentHash, version: '1.0.0', issuer: 'operator', workspaceId: 'workspace-a' }));
      await withEnv({ AXIOM_PLUGIN_STRICT: '1', AXIOM_SUPPLY_CHAIN_ACTIVATION_POLICY: JSON.stringify({ components: [{ ...component, contentHash }] }) }, async () => {
        const manager = new PluginManager(null);
        assert.strictEqual(manager.load(dir), 1);
        fs.appendFileSync(file, '// drift\n');
        await assert.rejects(() => manager.runCapability('safe.run', {}), /hash-drift/);
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
