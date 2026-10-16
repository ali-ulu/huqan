const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('./kernel');
const PluginManager = require('./plugin');
const {
  createProvenanceRegistry,
  recordPluginLoad,
  parseDependency,
  verifyDependencyGraph,
  revalidatePlugin,
} = require('./lib/plugin-provenance-registry');
const { TOOL_SCHEMAS, TOOL_PROVENANCE, getToolProvenance } = require('./lib/mcp-tool-catalog');
const { formatPluginCapabilityStatus } = require('./lib/cli-plugin-status');
const { revalidateGateArtifact } = require('./lib/external-action-gate-install');

function writePluginWithManifest(dir, name, opts = {}) {
  const pluginPath = path.join(dir, `${name}.js`);
  const manifestPath = path.join(dir, `${name}.manifest.json`);
  const capabilities = opts.capabilities || [{ name: `${name}Cap`, command: name, description: `${name} cap` }];
  fs.writeFileSync(pluginPath, `'use strict';\nmodule.exports = ${JSON.stringify({
    name,
    version: opts.version,
    issuer: opts.issuer,
    requires: opts.requires || [],
    optional: [],
    dependsOn: opts.dependsOn,
    capabilities,
  }).replace(/"run"/g, '"run"')};\nmodule.exports.run = async () => ({ ok: true });\n`);
  const sha256 = PluginManager.hashFile(pluginPath);
  const manifest = { sha256 };
  if (opts.version) manifest.version = opts.version;
  if (opts.issuer) manifest.issuer = opts.issuer;
  if (opts.capabilities) manifest.capabilities = opts.capabilities.map(cap => cap.name);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { pluginPath, manifestPath };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-1890-'));
}

test('1890: registry records signature, provenance, version, and granted capabilities per load', () => {
  const registry = createProvenanceRegistry();
  const { record } = recordPluginLoad(registry, {
    name: 'reporter',
    version: '1.2.0',
    issuer: 'huqan-core',
    signatureStatus: 'verified-signed',
    contentHash: 'a'.repeat(64),
    capabilities: [{ name: 'report' }],
    dependencies: [],
    filePath: '/plugins/reporter.js',
  });
  assert.equal(record.name, 'reporter');
  assert.equal(record.version, '1.2.0');
  assert.equal(record.issuer, 'huqan-core');
  assert.equal(record.signatureStatus, 'verified-signed');
  assert.deepEqual([...record.capabilities], ['report']);
  assert.equal(record.loadCount, 1);
});

test('1890: absent version/issuer are recorded explicitly, never inherited', () => {
  const registry = createProvenanceRegistry();
  recordPluginLoad(registry, { name: 'mystery', version: '2.0.0', issuer: 'someone', capabilities: [] });
  const { record } = recordPluginLoad(registry, { name: 'mystery', capabilities: [] });
  assert.equal(record.version, 'unversioned');
  assert.equal(record.issuer, 'unattested');
});

test('1890: capability change across versions produces a changelog entry', () => {
  const registry = createProvenanceRegistry();
  recordPluginLoad(registry, { name: 'reporter', version: '1.0.0', issuer: 'huqan-core', capabilities: ['a'] });
  const { changed, changelogEntry } = recordPluginLoad(registry, {
    name: 'reporter', version: '1.1.0', issuer: 'huqan-core', capabilities: ['a', 'b'],
  });
  assert.equal(changed, true);
  assert.equal(changelogEntry.plugin, 'reporter');
  assert.equal(changelogEntry.fromVersion, '1.0.0');
  assert.equal(changelogEntry.toVersion, '1.1.0');
  assert.deepEqual([...changelogEntry.addedCapabilities], ['b']);
  assert.deepEqual([...changelogEntry.removedCapabilities], []);
});

test('1890: dependency graph verifies missing deps, version pins, and cycles', () => {
  const registry = createProvenanceRegistry();
  recordPluginLoad(registry, { name: 'a', version: '1.0.0', capabilities: [], dependencies: ['missing-plugin'] });
  recordPluginLoad(registry, { name: 'b', version: '1.0.0', capabilities: [], dependencies: ['c@2.0.0'] });
  recordPluginLoad(registry, { name: 'c', version: '1.0.0', capabilities: [], dependencies: [] });
  recordPluginLoad(registry, { name: 'x', version: '1.0.0', capabilities: [], dependencies: ['y'] });
  recordPluginLoad(registry, { name: 'y', version: '1.0.0', capabilities: [], dependencies: ['x'] });
  const verdict = verifyDependencyGraph(registry);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.unsatisfied.some(item => item.plugin === 'a' && item.dependency === 'missing-plugin'));
  assert.ok(verdict.unsatisfied.some(item => item.plugin === 'b' && item.reason === 'dependency_version_mismatch'));
  assert.ok(verdict.cycles.some(cycle => cycle.includes('x') && cycle.includes('y')));
  assert.deepEqual(parseDependency('c@2.0.0'), { name: 'c', version: '2.0.0', spec: 'c@2.0.0' });
});

test('1890: runtime revalidation fails closed on hash drift and capability drift', () => {
  const registry = createProvenanceRegistry();
  const hash = 'b'.repeat(64);
  recordPluginLoad(registry, { name: 'reporter', version: '1.0.0', capabilities: ['a'], contentHash: hash });
  assert.deepEqual(
    revalidatePlugin(registry, 'reporter', { capabilities: ['a'], contentHash: hash }).ok,
    true,
  );
  assert.equal(
    revalidatePlugin(registry, 'reporter', { capabilities: ['a'], contentHash: 'c'.repeat(64) }).reason,
    'content_hash_drift',
  );
  const drifted = revalidatePlugin(registry, 'reporter', { capabilities: ['a', 'evil'], contentHash: hash });
  assert.equal(drifted.reason, 'capability_drift');
  assert.equal(registry.changelog.length, 1);
  assert.equal(registry.changelog[0].reason, 'runtime_capability_drift');
  assert.equal(revalidatePlugin(registry, 'ghost', {}).reason, 'provenance_not_recorded');
});

test('1890: load() records provenance and evicts plugins with unsatisfied dependencies', () => {
  const dir = tempDir();
  writePluginWithManifest(dir, 'lonely', { version: '1.0.0', issuer: 'huqan-core', dependsOn: ['never-there'] });
  writePluginWithManifest(dir, 'solid', { version: '1.0.0', issuer: 'huqan-core' });
  const kernel = { hasCapability: () => true };
  const manager = new PluginManager(kernel);
  const errors = [];
  const originalError = console.error;
  console.error = msg => errors.push(String(msg));
  try {
    manager.load(dir);
  } finally {
    console.error = originalError;
  }
  assert.ok(manager.plugins.some(plugin => plugin.name === 'solid'));
  assert.ok(!manager.plugins.some(plugin => plugin.name === 'lonely'));
  assert.ok(errors.some(msg => msg.includes('lonely') && msg.includes('never-there')));
  const record = manager.provenanceRecord('solid');
  assert.equal(record.version, '1.0.0');
  assert.equal(record.issuer, 'huqan-core');
  assert.equal(record.signatureStatus, 'verified');
  assert.ok(record.capabilities.includes('solidCap'));
});

test('1890: runCapability re-evaluates the grant at runtime, not just at load', async () => {
  const enabled = { llm: true };
  const manager = new PluginManager({ hasCapability: name => enabled[name] === true });
  manager.register({
    name: 'runtime-gated',
    requires: ['llm'],
    optional: [],
    capabilities: [{ name: 'liveCap', command: 'live', description: 'live cap' }],
    run: async () => ({ ok: true }),
  });
  const first = await manager.runCapability('liveCap', {});
  assert.equal(first.ok, true);
  // A kernel capability switched off after load must block the next call.
  enabled.llm = false;
  await assert.rejects(
    () => manager.runCapability('liveCap', {}),
    error => error.code === 'PLUGIN_RUNTIME_REVALIDATION_FAILED'
      && /required_capability_disabled/.test(error.message),
  );
});

test('1890: runCapability blocks when the plugin file drifts after load', async () => {
  const dir = tempDir();
  writePluginWithManifest(dir, 'drifter', { version: '1.0.0', issuer: 'huqan-core' });
  const kernel = { hasCapability: () => true };
  const manager = new PluginManager(kernel);
  const errors = [];
  const originalError = console.error;
  console.error = msg => errors.push(String(msg));
  try {
    manager.load(dir);
  } finally {
    console.error = originalError;
  }
  assert.ok(manager.plugins.some(plugin => plugin.name === 'drifter'));
  fs.appendFileSync(path.join(dir, 'drifter.js'), '\n// tampered\n');
  await assert.rejects(
    () => manager.runCapability('drifterCap', {}),
    error => error.code === 'PLUGIN_RUNTIME_REVALIDATION_FAILED' && /content_hash_drift/.test(error.message),
  );
});

test('1890: revalidatePlugins reports per-plugin results without invoking', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.usePlugin({ name: 'quiet', capabilities: [{ name: 'quietCap', command: 'quiet', description: 'q' }], run: async () => ({ ok: true }) });
  const results = k.plugins.revalidatePlugins();
  assert.deepEqual(results, [{ plugin: 'quiet', ok: true, reason: 'grant_unchanged' }]);
});

test('1890: capabilitySummary carries provenance; status prints the identity chain', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.usePlugin({
    name: 'shown',
    version: '3.1.0',
    issuer: 'huqan-core',
    capabilities: [{ name: 'shownCap', command: 'shown', description: 's' }],
    run: async () => ({ ok: true }),
  });
  const summary = k.plugins.capabilitySummary();
  assert.deepEqual(summary.provenance, [{
    plugin: 'shown',
    version: '3.1.0',
    issuer: 'huqan-core',
    signatureStatus: 'unverified',
    capabilities: ['shownCap'],
  }]);
  const text = formatPluginCapabilityStatus(k.plugins);
  assert.ok(text.includes('v3.1.0 by huqan-core [unverified]'));
});

test('1890: every MCP tool carries publisher, version, and signature provenance', () => {
  assert.ok(TOOL_SCHEMAS.length > 0);
  for (const tool of TOOL_SCHEMAS) {
    const provenance = getToolProvenance(tool.name);
    assert.ok(provenance, `missing provenance for ${tool.name}`);
    assert.equal(provenance.publisher, 'huqan-core');
    assert.ok(provenance.version && provenance.version !== 'unversioned');
    assert.equal(provenance.signatureStatus, 'first-party-bundled');
  }
  assert.equal(getToolProvenance('no-such-tool'), null);
});

test('1890: gate revalidation reports not-installed without writing anything', () => {
  const dir = tempDir();
  const result = revalidateGateArtifact('codex', dir);
  assert.equal(result.installed, false);
  assert.equal(result.live, false);
  assert.equal(result.reason, 'gate_not_installed');
  assert.equal(fs.existsSync(path.join(dir, '.codex', 'hooks.json')), false);
});
