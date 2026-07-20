const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { createAxiomClient } = require('../lib/sdk');
const { createWorkflowTools } = require('../workflow-tools');

test('Kernel capability execution fails closed before PluginManager delegation', async () => {
  let pluginCalls = 0;
  const kernel = Object.create(Kernel.prototype);
  kernel.capabilities = { pluginCapabilities: false };
  kernel.plugins = {
    async runCapability() {
      pluginCalls += 1;
    },
  };

  await assert.rejects(
    kernel.runCapability('demo', { value: 1 }),
    (error) => error.code === 'CAPABILITY_REQUIRED' && error.capability === 'pluginCapabilities',
  );
  assert.equal(pluginCalls, 0);
});

test('Kernel capability execution delegates once and preserves result identity', async () => {
  const expected = Object.freeze({ ok: true, value: 1 });
  const calls = [];
  const kernel = Object.create(Kernel.prototype);
  kernel.capabilities = { pluginCapabilities: true };
  kernel.plugins = {
    async runCapability(name, input, opts) {
      calls.push([name, input, opts]);
      return expected;
    },
  };
  const input = Object.freeze({ value: 1 });
  const opts = Object.freeze({ workspaceId: 'workspace-a' });

  assert.strictEqual(await kernel.runCapability('demo', input, opts), expected);
  assert.deepEqual(calls, [['demo', input, opts]]);
});

test('Kernel capability execution preserves PluginManager rejection identity', async () => {
  const expectedError = new Error('plugin failed');
  const kernel = Object.create(Kernel.prototype);
  kernel.capabilities = { pluginCapabilities: true };
  kernel.plugins = {
    async runCapability() {
      throw expectedError;
    },
  };

  await assert.rejects(kernel.runCapability('demo', {}), (error) => error === expectedError);
});

test('Kernel capability discovery preserves manager results and bounded fallbacks', () => {
  const expectedList = Object.freeze([{ name: 'demo' }]);
  const expectedCapability = expectedList[0];
  const kernel = Object.create(Kernel.prototype);

  kernel.plugins = {
    listCapabilities() { return expectedList; },
    getCapability() { return expectedCapability; },
  };
  assert.strictEqual(kernel.listCapabilities(), expectedList);
  assert.strictEqual(kernel.getCapability('demo'), expectedCapability);

  kernel.plugins = null;
  assert.deepEqual(kernel.listCapabilities(), []);
  assert.equal(kernel.getCapability('demo'), null);
});

test('KernelV2 preserves wrapped Kernel capability result and rejection identity', async () => {
  const expected = Object.freeze({ ok: true });
  const expectedError = new Error('capability failed');
  const wrapped = {
    runCapability() { return Promise.resolve(expected); },
  };
  const kernelV2 = Object.create(KernelV2.prototype);
  kernelV2.kernel = wrapped;

  assert.strictEqual(await kernelV2.runCapability('demo', {}), expected);

  wrapped.runCapability = () => Promise.reject(expectedError);
  await assert.rejects(kernelV2.runCapability('demo', {}), (error) => error === expectedError);
});

test('KernelV2 delegates capability state and discovery only to wrapped Kernel', () => {
  const calls = [];
  const expectedList = Object.freeze([{ name: 'demo' }]);
  const expectedCapability = expectedList[0];
  const kernelV2 = Object.create(KernelV2.prototype);
  kernelV2.kernel = {
    hasCapability(name) { calls.push(['has', name]); return true; },
    enableCapability(name) { calls.push(['enable', name]); return true; },
    requireCapability(name) { calls.push(['require', name]); return true; },
    listCapabilities() { calls.push(['list']); return expectedList; },
    getCapability(name) { calls.push(['get', name]); return expectedCapability; },
  };

  assert.equal(kernelV2.hasCapability('demo'), true);
  assert.equal(kernelV2.enableCapability('demo'), true);
  assert.equal(kernelV2.requireCapability('demo'), true);
  assert.strictEqual(kernelV2.listCapabilities(), expectedList);
  assert.strictEqual(kernelV2.getCapability('demo'), expectedCapability);
  assert.deepEqual(calls, [
    ['has', 'demo'],
    ['enable', 'demo'],
    ['require', 'demo'],
    ['list'],
    ['get', 'demo'],
  ]);
});

test('SDK prefers governed Kernel runner and uses PluginManager only as compatibility fallback', async () => {
  const calls = [];
  const kernel = {
    async runCapability(name, input, opts) {
      calls.push(['kernel', name, input, opts]);
      return { owner: 'kernel' };
    },
    plugins: {
      async runCapability(name, input, opts) {
        calls.push(['plugins', name, input, opts]);
        return { owner: 'plugins' };
      },
    },
  };

  assert.deepEqual(await createAxiomClient(kernel).runCapability('demo', { a: 1 }), { owner: 'kernel' });
  delete kernel.runCapability;
  assert.deepEqual(await createAxiomClient(kernel).runCapability('demo', { a: 2 }), { owner: 'plugins' });
  assert.deepEqual(calls.map((call) => call[0]), ['kernel', 'plugins']);
});

test('workflow capability execution fails closed through the governed Kernel facade', async () => {
  let pluginCalls = 0;
  const kernel = Object.create(Kernel.prototype);
  kernel.capabilities = { pluginCapabilities: false };
  kernel.plugins = {
    async runCapability() {
      pluginCalls += 1;
    },
  };
  const tool = createWorkflowTools(kernel).find(candidate => candidate.name === 'runCapability');

  const result = await tool.run({}, { name: 'demo', input: { value: 1 } });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CAPABILITY_REQUIRED');
  assert.equal(pluginCalls, 0);
  assert.equal(result.meta.source, 'kernel.runCapability');
});

test('capability declarations match the existing Kernel and KernelV2 runtime facade', () => {
  const kernelDeclaration = fs.readFileSync(path.join(__dirname, '..', 'kernel.d.ts'), 'utf8');
  const kernelV2Declaration = fs.readFileSync(path.join(__dirname, '..', 'kernel.v2.d.ts'), 'utf8');
  const methods = [
    'hasCapability',
    'enableCapability',
    'requireCapability',
    'listCapabilities',
    'getCapability',
    'runCapability',
  ];

  assert.match(kernelDeclaration, /capabilities\?: Partial<Record<KernelCapabilityName, boolean>>/);
  for (const method of methods) {
    assert.match(kernelDeclaration, new RegExp(`\\b${method}\\s*\\(`));
    assert.match(kernelV2Declaration, new RegExp(`\\b${method}\\s*\\(`));
  }
  assert.doesNotMatch(kernelV2Declaration, /\bplugins\s*:/);
});
