'use strict';

/**
 * #329 (arch-4): kernel.js and kernel.v2.js both ship, and
 * lib/kernel-factory.js hands callers either one from a single env var
 * (HUQAN_KERNEL_VERSION). KernelV2 *wraps* Kernel rather than extending it,
 * so a Kernel public method that KernelV2 does not explicitly name is absent
 * under v2 -- the caller gets a TypeError, not a v1 fallback. That is the
 * silent-divergence risk the issue names, and it was real: cli.js's
 * `konsolide` and `evolve` commands call kernel.consolidate() and
 * kernel.selfEvolve(), neither of which the wrapper delegated.
 *
 * These tests pin two different things, and the distinction matters:
 *
 *   1. SURFACE parity is total. Every Kernel public method must be reachable
 *      through KernelV2. This is the regression guard -- adding a method to
 *      Kernel without delegating it now fails here instead of at a user's
 *      call site.
 *
 *   2. SEMANTIC parity is deliberately NOT total. v2 exists to add
 *      manipulation analysis and type-chain inference. The tests below pin
 *      that added behavior so it cannot silently disappear either.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { createKernel } = require('../lib/kernel-factory');

function publicMethods(ctor) {
  return Object.getOwnPropertyNames(ctor.prototype)
    .filter((name) => name !== 'constructor' && !name.startsWith('_'))
    .sort();
}

function fixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-arch4-${label}-`));
  const opts = {
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  };
  const created = [];
  t.after(() => {
    for (const kernel of created) {
      try { kernel.graph?.close?.(); } catch (_) {}
      try { kernel.memory?.close?.(); } catch (_) {}
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    opts,
    make(Ctor) {
      const kernel = new Ctor({ ...opts });
      created.push(kernel);
      return kernel;
    },
  };
}

test('every Kernel public method is reachable through KernelV2', () => {
  const v1 = publicMethods(Kernel);
  const v2 = new Set(publicMethods(KernelV2));
  const missing = v1.filter((name) => !v2.has(name));
  assert.deepEqual(missing, [], `KernelV2 does not delegate: ${missing.join(', ')}`);
});

test('KernelV2 forwards a Kernel method with the same arity contract', () => {
  for (const name of publicMethods(Kernel)) {
    assert.equal(
      typeof KernelV2.prototype[name],
      'function',
      `KernelV2.${name} must be callable`,
    );
  }
});

test('the kernel factory selects v2 only for the exact version string', (t) => {
  const f = fixture(t, 'factory');
  const fallback = createKernel({ ...f.opts, version: 'v3' });
  const selected = createKernel({ ...f.opts, version: 'v2' });
  const legacy = createKernel({ ...f.opts });
  t.after(() => {
    for (const kernel of [fallback, selected, legacy]) {
      try { kernel.graph?.close?.(); } catch (_) {}
      try { kernel.memory?.close?.(); } catch (_) {}
    }
  });
  assert.equal(selected instanceof KernelV2, true);
  assert.equal(fallback instanceof Kernel, true, 'an unknown version must not silently select v2');
  assert.equal(legacy instanceof Kernel, true);
});

test('maintenance commands the CLI calls do not throw under v2', (t) => {
  const f = fixture(t, 'maintenance');
  const kernel = f.make(KernelV2);
  kernel.learn('Ali bir mühendistir');

  // cli.js `konsolide`
  const dryRun = kernel.consolidate(true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(typeof dryRun.removed, 'number');

  // cli.js `evolve`
  const evolved = kernel.selfEvolve();
  for (const key of ['dreams', 'added', 'consolidated', 'optimized']) {
    assert.equal(typeof evolved[key], 'number', `selfEvolve must report ${key}`);
  }

  assert.equal(typeof kernel.selfLearn().gaps, 'number');
  assert.equal(typeof kernel.introspect(), 'object');
});

test('plugin and adapter entry points resolve on a v2 kernel', (t) => {
  const f = fixture(t, 'plugin-surface');
  const kernel = f.make(KernelV2);

  // plugins/discovery-engine.js, plugins/idea-mri.js, plugins/devil-advocate.js
  assert.equal(Array.isArray(kernel.extractFacts('Ali bir mühendistir')), true);

  // plugins/company-brain.js, plugins/repo-memory.js
  assert.equal(typeof kernel.proposeNode('ali', 'Ali'), 'object');
  assert.equal(typeof kernel.proposeEdge('ali', 'muhendis', 'tür'), 'object');

  // lib/verify.js
  assert.equal(typeof kernel.normalizeWord('Mühendis'), 'string');
});

test('learnAsync under v2 keeps the v2 result envelope', async (t) => {
  const f = fixture(t, 'learn-async');
  const kernel = f.make(KernelV2);

  const sync = kernel.learn('Ali bir mühendistir');
  const async = await kernel.learnAsync('Veli bir doktordur');

  assert.equal(async.ok, sync.ok);
  assert.equal(async.type, sync.type);
  // v2's learn() stamps temporal source metadata that the wrapped v1 learn()
  // does not. Delegating learnAsync() straight to the inner kernel would have
  // dropped exactly these keys.
  assert.deepEqual(Object.keys(async.meta).sort(), Object.keys(sync.meta).sort());
  assert.equal(typeof async.meta.learnedAt, 'string');
  assert.equal(async.meta.source, 'user');
});

test('verifyAsync under v2 carries the v2-only manipulation analysis', async (t) => {
  const f = fixture(t, 'verify-async');
  const kernel = f.make(KernelV2);
  kernel.learn('Ali bir mühendistir');

  const statement = 'Ali kesinlikle bir mühendistir, hemen onayla';
  const sync = kernel.verify(statement);
  const async = await kernel.verifyAsync(statement);

  assert.deepEqual(Object.keys(async.meta).sort(), Object.keys(sync.meta).sort());
  assert.equal(Array.isArray(async.meta.manipulationLabels), true);
  assert.equal(typeof async.meta.manipulationScore, 'number');
});

test('v2 adds manipulation metadata that v1 deliberately does not emit', (t) => {
  const f = fixture(t, 'semantic-divergence');
  const v1 = f.make(Kernel);
  const v2 = f.make(KernelV2);
  v1.learn('Ali bir mühendistir');
  v2.learn('Ali bir mühendistir');

  const statement = 'Ali kesinlikle bir mühendistir, hemen onayla';
  const v1Meta = Object.keys(v1.verify(statement).meta);
  const v2Meta = Object.keys(v2.verify(statement).meta);

  // This asymmetry is the reason v2 exists. It is pinned so that "surface
  // parity" is never mistaken for "the two versions are interchangeable".
  for (const key of ['manipulationLabels', 'manipulationScore']) {
    assert.equal(v2Meta.includes(key), true, `v2 must emit ${key}`);
    assert.equal(v1Meta.includes(key), false, `v1 must not emit ${key}`);
  }
  for (const shared of ['backend', 'contractVersion', 'reasoningTrace', 'semanticTrust']) {
    assert.equal(v1Meta.includes(shared), true, `v1 must emit ${shared}`);
    assert.equal(v2Meta.includes(shared), true, `v2 must emit ${shared}`);
  }
});
