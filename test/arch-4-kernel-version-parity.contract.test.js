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
 *   1. PUBLIC-METHOD parity is total for prototype methods. Every Kernel
 *      public prototype method must be reachable through KernelV2. This is
 *      the regression guard -- adding a method to Kernel without delegating
 *      it now fails here instead of at a user's call site. Instance fields,
 *      getters and type declarations are intentionally outside this contract.
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
const { createKernel, CANONICAL_KERNEL_VERSION } = require('../lib/kernel-factory');

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

test('every Kernel public prototype method is reachable through KernelV2', () => {
  const v1 = publicMethods(Kernel);
  const v2 = new Set(publicMethods(KernelV2));
  const missing = v1.filter((name) => !v2.has(name));
  assert.deepEqual(missing, [], `KernelV2 does not delegate: ${missing.join(', ')}`);
});

test('KernelV2 exposes every Kernel public prototype method as callable', () => {
  for (const name of publicMethods(Kernel)) {
    assert.equal(
      typeof KernelV2.prototype[name],
      'function',
      `KernelV2.${name} must be callable`,
    );
  }
});

test('the kernel factory always builds the canonical kernel', (t) => {
  const f = fixture(t, 'factory');
  const implicit = createKernel({ ...f.opts });
  const explicit = createKernel({ ...f.opts, version: CANONICAL_KERNEL_VERSION });
  const blank = createKernel({ ...f.opts, version: '' });
  t.after(() => {
    for (const kernel of [implicit, explicit, blank]) {
      try { kernel.graph?.close?.(); } catch (_) {}
      try { kernel.memory?.close?.(); } catch (_) {}
    }
  });
  for (const kernel of [implicit, explicit, blank]) {
    assert.equal(kernel instanceof KernelV2, true);
    assert.equal(kernel instanceof Kernel, false, 'KernelV2 wraps Kernel, it does not extend it');
  }
});

test('a legacy kernel version request fails fast instead of selecting v1', (t) => {
  const f = fixture(t, 'factory-legacy');
  for (const version of ['v1', 'legacy', '1', 'V3']) {
    assert.throws(
      () => createKernel({ ...f.opts, version }),
      (error) => error.code === 'HUQAN_KERNEL_VERSION_UNSUPPORTED' && error.requested === version,
      `version=${version} must fail closed`,
    );
  }
});

test('a legacy kernel version in the environment fails fast', (t) => {
  const f = fixture(t, 'factory-env');
  const had = Object.prototype.hasOwnProperty.call(process.env, 'HUQAN_KERNEL_VERSION');
  const previous = process.env.HUQAN_KERNEL_VERSION;
  t.after(() => {
    if (had) process.env.HUQAN_KERNEL_VERSION = previous;
    else delete process.env.HUQAN_KERNEL_VERSION;
  });

  process.env.HUQAN_KERNEL_VERSION = 'v1';
  assert.throws(
    () => createKernel({ ...f.opts }),
    { code: 'HUQAN_KERNEL_VERSION_UNSUPPORTED' },
  );

  process.env.HUQAN_KERNEL_VERSION = CANONICAL_KERNEL_VERSION;
  const canonical = createKernel({ ...f.opts });
  t.after(() => {
    try { canonical.graph?.close?.(); } catch (_) {}
    try { canonical.memory?.close?.(); } catch (_) {}
  });
  assert.equal(canonical instanceof KernelV2, true, 'the canonical value stays accepted');
});

test('the canonical kernel exposes the instance data entry points read', (t) => {
  const f = fixture(t, 'instance-data');
  const kernel = f.make(KernelV2);

  // server.js's graph-data endpoint reads these behind presence guards, so a
  // missing field degrades silently rather than throwing.
  assert.notEqual(kernel.memory, undefined, 'server.js reads kernel.memory');
  assert.notEqual(kernel.graph, undefined);
  assert.notEqual(kernel.plugins, undefined);
  assert.equal(typeof kernel.contractVersion, typeof f.make(Kernel).contractVersion);
});

test('wrapping an already-canonical kernel reuses it instead of building a second', (t) => {
  const f = fixture(t, 'rewrap');
  const canonical = f.make(KernelV2);
  const rewrapped = new KernelV2({ kernel: canonical });

  assert.equal(rewrapped.kernel, canonical.kernel, 'the inner v1 kernel must be shared');
  assert.equal(rewrapped.graph, canonical.graph);
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

  // This asymmetry is the reason v2 exists. It is pinned so that "method
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
