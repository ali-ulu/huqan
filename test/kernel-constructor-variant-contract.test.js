const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PackageKernel = require('..');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const CLI = require('../cli');
const { createKernelFromEnv } = require('../mcpServer');

const ENV_KEYS = Object.freeze([
  'AXIOM_KERNEL_VERSION',
  'AXIOM_MEMORY_PATH',
  'AXIOM_DB_PATH',
  'AXIOM_USE_SQLITE',
]);

function captureEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, {
    exists: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key].exists) process.env[key] = snapshot[key].value;
    else delete process.env[key];
  }
}

function assertEnvMatches(snapshot) {
  for (const key of ENV_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(process.env, key),
      snapshot[key].exists,
      `${key} presence must be restored`,
    );
    assert.equal(process.env[key], snapshot[key].value, `${key} value must be restored`);
  }
}

function applyEnv(overrides) {
  for (const key of ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
}

function makeTempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `huqan-kernel-variant-${label}-`));
}

function isolatedKernelOptions(root, overrides = {}) {
  return {
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
    ...overrides,
  };
}

function closeKernel(instance) {
  if (instance?.graph && typeof instance.graph.close === 'function') instance.graph.close();
}

function createManagedCliKernel({ label, mode = 'options', options = {}, env = {} }) {
  const root = makeTempRoot(label);
  const envBefore = captureEnv();
  const cwdBefore = process.cwd();
  let instance;

  try {
    applyEnv(env);
    process.chdir(root);
    if (mode === 'no-args') instance = CLI.createKernel();
    else if (mode === 'empty-options') instance = CLI.createKernel({});
    else instance = CLI.createKernel(isolatedKernelOptions(root, options));
  } catch (error) {
    closeKernel(instance);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    process.chdir(cwdBefore);
    restoreEnv(envBefore);
  }

  assertEnvMatches(envBefore);
  return {
    instance,
    dispose() {
      closeKernel(instance);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function createManagedMcpKernel({ label, version }) {
  const root = makeTempRoot(label);
  const envBefore = captureEnv();
  let instance;

  try {
    applyEnv({
      AXIOM_KERNEL_VERSION: version,
      AXIOM_MEMORY_PATH: path.join(root, 'memory.json'),
      AXIOM_DB_PATH: path.join(root, 'memory.db'),
      AXIOM_USE_SQLITE: 'false',
    });
    instance = createKernelFromEnv();
  } catch (error) {
    closeKernel(instance);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    restoreEnv(envBefore);
  }

  assertEnvMatches(envBefore);
  return {
    instance,
    dispose() {
      closeKernel(instance);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the package entry point still exports the internal v1 implementation', { concurrency: false }, () => {
  // #329 criterion 2 removed the *runtime* selection. The published package
  // export is a separate, unresolved API decision: require('huqan') still
  // hands out kernel.js. It is pinned here so that changing it is a deliberate
  // act with its own review, not a side effect of this refactor.
  assert.equal(PackageKernel, Kernel);
  assert.notEqual(KernelV2, Kernel);
  assert.equal(typeof PackageKernel, 'function');
});

test('CLI builds the canonical kernel with no selector present', { concurrency: false }, () => {
  const noArgs = createManagedCliKernel({
    label: 'cli-no-args',
    mode: 'no-args',
    env: { AXIOM_KERNEL_VERSION: undefined },
  });
  const emptyOptions = createManagedCliKernel({
    label: 'cli-empty-options',
    mode: 'empty-options',
    env: { AXIOM_KERNEL_VERSION: undefined },
  });

  try {
    for (const managed of [noArgs, emptyOptions]) {
      assert.ok(managed.instance instanceof KernelV2);
      assert.ok(!(managed.instance instanceof Kernel));
    }
  } finally {
    noArgs.dispose();
    emptyOptions.dispose();
  }
});

test('CLI rejects a legacy kernel selector instead of falling back to v1', { concurrency: false }, () => {
  for (const [label, config] of [
    ['cli-env-legacy', { env: { AXIOM_KERNEL_VERSION: 'legacy' } }],
    ['cli-option-legacy', { options: { version: 'legacy' }, env: { AXIOM_KERNEL_VERSION: undefined } }],
    ['cli-option-v1', { options: { version: 'v1' }, env: { AXIOM_KERNEL_VERSION: undefined } }],
  ]) {
    assert.throws(
      () => createManagedCliKernel({ label, ...config }),
      { code: 'HUQAN_KERNEL_VERSION_UNSUPPORTED' },
      label,
    );
  }
});

test('CLI accepts the canonical selector from options or environment', { concurrency: false }, () => {
  const optionSelected = createManagedCliKernel({
    label: 'cli-option-v2',
    options: { version: 'v2' },
    env: { AXIOM_KERNEL_VERSION: undefined },
  });
  const envSelected = createManagedCliKernel({
    label: 'cli-env-v2',
    env: { AXIOM_KERNEL_VERSION: 'v2' },
  });

  try {
    assert.ok(optionSelected.instance instanceof KernelV2);
    assert.ok(envSelected.instance instanceof KernelV2);
    assert.equal(require('..'), Kernel);
  } finally {
    optionSelected.dispose();
    envSelected.dispose();
  }
});

test('the canonical CLI kernel exposes the bounded audit seam', { concurrency: false }, () => {
  const managed = createManagedCliKernel({
    label: 'cli-audit-seam',
    env: { AXIOM_KERNEL_VERSION: undefined },
  });

  try {
    assert.ok(managed.instance instanceof KernelV2);
    assert.equal(typeof managed.instance.recordCliMutationAudit, 'function');
  } finally {
    managed.dispose();
  }
});

test('an empty option selector defers to the environment, and both canonical values agree', { concurrency: false }, () => {
  const emptyOption = createManagedCliKernel({
    label: 'cli-precedence-empty-option',
    options: { version: '' },
    env: { AXIOM_KERNEL_VERSION: 'v2' },
  });

  try {
    assert.ok(emptyOption.instance instanceof KernelV2);
  } finally {
    emptyOption.dispose();
  }

  // A legacy value anywhere in the chain fails, even paired with a canonical
  // value elsewhere -- precedence cannot launder a removed selector.
  assert.throws(
    () => createManagedCliKernel({
      label: 'cli-precedence-option-legacy',
      options: { version: 'legacy' },
      env: { AXIOM_KERNEL_VERSION: 'v2' },
    }),
    { code: 'HUQAN_KERNEL_VERSION_UNSUPPORTED' },
  );
  assert.throws(
    () => createManagedCliKernel({
      label: 'cli-precedence-env-legacy',
      options: { version: 'v2' },
      env: { AXIOM_KERNEL_VERSION: 'legacy' },
    }),
    { code: 'HUQAN_KERNEL_VERSION_UNSUPPORTED' },
  );
});

test('MCP builds the canonical kernel for absent and empty selectors', { concurrency: false }, () => {
  const absent = createManagedMcpKernel({ label: 'mcp-absent', version: undefined });
  const empty = createManagedMcpKernel({ label: 'mcp-empty', version: '' });
  const canonical = createManagedMcpKernel({ label: 'mcp-v2', version: 'v2' });

  try {
    for (const managed of [absent, empty, canonical]) {
      assert.ok(managed.instance instanceof KernelV2);
      assert.ok(!(managed.instance instanceof Kernel));
    }
    assert.equal(require('..'), Kernel);
  } finally {
    absent.dispose();
    empty.dispose();
    canonical.dispose();
  }
});

test('MCP rejects a legacy kernel selector', { concurrency: false }, () => {
  assert.throws(
    () => createManagedMcpKernel({ label: 'mcp-legacy', version: 'legacy' }),
    { code: 'HUQAN_KERNEL_VERSION_UNSUPPORTED' },
  );
});

test('environment isolation restores prior presence and values', { concurrency: false }, () => {
  const before = captureEnv();

  try {
    applyEnv({
      AXIOM_KERNEL_VERSION: 'v2',
      AXIOM_MEMORY_PATH: 'temporary-memory.json',
      AXIOM_DB_PATH: 'temporary-memory.db',
      AXIOM_USE_SQLITE: 'false',
    });
    assert.equal(process.env.AXIOM_KERNEL_VERSION, 'v2');
    assert.equal(process.env.AXIOM_MEMORY_PATH, 'temporary-memory.json');
    assert.equal(process.env.AXIOM_DB_PATH, 'temporary-memory.db');
    assert.equal(process.env.AXIOM_USE_SQLITE, 'false');
  } finally {
    restoreEnv(before);
  }

  assertEnvMatches(before);
});
