const test = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('./kernel');

test('plugin contract: optional capability missing logs warning but plugin loads', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { llm: false } });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    k.usePlugin({
      name: 'optional-check',
      requires: [],
      optional: ['llm'],
      capabilities: [
        { name: 'dummy', command: 'dummy', description: 'dummy cap' },
      ],
      run: async () => ({ ok: true }),
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(k.plugins.plugins.some(p => p.name === 'optional-check'), true);
  // #1694: the notice is recorded for `huqan status`, not written to the
  // console -- five of these on every command made a correct default
  // configuration look like a broken install.
  assert.equal(warnings.length, 0, 'capability notices must not be printed');
  assert.deepEqual(
    k.plugins.capabilitySummary().degraded,
    [{ plugin: 'optional-check', capability: 'llm' }],
  );
});

test('plugin contract: kernel.runCapability requires pluginCapabilities gate', async () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.usePlugin({
    name: 'cap-gated',
    requires: [],
    optional: [],
    capabilities: [{ name: 'dummyCap', command: 'dummy', description: 'dummy capability' }],
    run: async () => ({ ok: true, from: 'plugin' }),
  });

  await assert.rejects(
    () => k.runCapability('dummyCap', { a: 1 }),
    /Required capability is not enabled: pluginCapabilities/
  );

  k.enableCapability('pluginCapabilities');
  const res = await k.runCapability('dummyCap', { a: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.from, 'plugin');
});

test('plugin contract: kernel.listCapabilities proxies plugin capabilities', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.usePlugin({
    name: 'cap-list',
    requires: [],
    optional: [],
    capabilities: [{ name: 'ideaMri', command: 'mri', description: 'Idea MRI' }],
    run: async () => ({ ok: true }),
  });

  const list = k.listCapabilities();
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 1);
  assert.equal(list[0].plugin, 'cap-list');
  assert.equal(k.getCapability('mri').name, 'ideaMri');
});
