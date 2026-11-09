'use strict';

// #4558: the Graph defaults to SQLite (`useSQLite !== false`) while MemoryStore
// defaults to the process-only backend, so a boot that names no SQLite choice
// persisted the graph and dropped every memory record on exit -- with no boot
// signal. Two things must hold now: `USE_SQLITE` is understood in its ordinary
// spelling (truthy opts in), and a process-only memory core says so at boot and
// in its mutation envelopes. This file pins both halves.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { buildKernelOptsFromEnv, warnIfMemoryBackendEphemeral } = require('../lib/kernel-factory');
const Kernel = require('../kernel');
const MemoryStore = require('../lib/memory-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4558-'));
}

// Run `body` with HUQAN_USE_SQLITE set to `value` (or unset when undefined),
// restoring the previous state afterwards so the process env stays clean.
function withUseSqliteEnv(value, body) {
  const previous = process.env.HUQAN_USE_SQLITE;
  try {
    if (value === undefined) delete process.env.HUQAN_USE_SQLITE;
    else process.env.HUQAN_USE_SQLITE = value;
    return body();
  } finally {
    if (previous === undefined) delete process.env.HUQAN_USE_SQLITE;
    else process.env.HUQAN_USE_SQLITE = previous;
  }
}

describe('USE_SQLITE is normalized at the kernel factory (#4558)', () => {
  it("the ordinary opt-in spelling '1' turns SQLite on", () => {
    withUseSqliteEnv('1', () => {
      assert.strictEqual(buildKernelOptsFromEnv().useSQLite, true);
    });
  });

  it("'true' and the legacy '0'/'false' spellings agree with MemoryStore (#4559)", () => {
    withUseSqliteEnv('true', () => assert.strictEqual(buildKernelOptsFromEnv().useSQLite, true));
    withUseSqliteEnv('false', () => assert.strictEqual(buildKernelOptsFromEnv().useSQLite, false));
    withUseSqliteEnv('0', () => assert.strictEqual(buildKernelOptsFromEnv().useSQLite, false));
  });

  it('an unrecognized value is refused instead of guessed', () => {
    withUseSqliteEnv('yes', () => {
      assert.throws(() => buildKernelOptsFromEnv(), { code: 'HUQAN_INVALID_USE_SQLITE' });
    });
  });

  it('an absent or blank value leaves the runtime default in place', () => {
    withUseSqliteEnv(undefined, () => assert.strictEqual(buildKernelOptsFromEnv().useSQLite, undefined));
    withUseSqliteEnv('', () => assert.strictEqual(buildKernelOptsFromEnv().useSQLite, undefined));
    withUseSqliteEnv('   ', () => assert.strictEqual(buildKernelOptsFromEnv().useSQLite, undefined));
  });
});

describe('boot warns when the memory core cannot persist (#4558)', () => {
  it('a default kernel warns and names the divergence without writing a store', () => {
    const dir = tmpDir();
    const memoryPath = path.join(dir, 'memory.json');
    const kernel = new Kernel({ memoryPath, noLoad: true });
    assert.strictEqual(kernel.memory._storePort.backend(), 'memory');
    assert.ok(kernel.graph._db, 'the graph persists by default');

    const warnings = [];
    const emitted = warnIfMemoryBackendEphemeral(kernel, { warn: message => warnings.push(message) });

    assert.strictEqual(emitted, true);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /memory core is not persistent/);
    assert.match(warnings[0], /graph persists to SQLite while memory records do not/);
    // The remedy must name the environment variables the runtime actually reads.
    assert.match(warnings[0], /HUQAN_USE_SQLITE=1/);
    assert.match(warnings[0], /HUQAN_DB_PATH/);
    assert.doesNotMatch(warnings[0], /\bUSE_SQLITE=1\b/);
    // The warning reports a state, never the resolved path.
    assert.equal(warnings[0].includes(memoryPath), false, 'the message must not leak the path');
    // Reading the backend must not itself create the JSON store.
    assert.equal(fs.existsSync(memoryPath), false, 'a boot warning must not create a store');

    kernel.graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a SQLite-backed memory core stays quiet', () => {
    const dir = tmpDir();
    const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 'memory.db') });
    const warnings = [];
    const emitted = warnIfMemoryBackendEphemeral({ memory: store, graph: {} }, { warn: m => warnings.push(m) });

    assert.strictEqual(emitted, false);
    assert.deepEqual(warnings, []);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a JSON-backed memory core stays quiet', () => {
    const dir = tmpDir();
    const store = new MemoryStore({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
    const warnings = [];
    const emitted = warnIfMemoryBackendEphemeral({ memory: store, graph: {} }, { warn: m => warnings.push(m) });

    assert.strictEqual(emitted, false);
    assert.deepEqual(warnings, []);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a kernel with no memory core is tolerated', () => {
    assert.strictEqual(warnIfMemoryBackendEphemeral({}, { warn: () => { throw new Error('must not warn'); } }), false);
    assert.strictEqual(warnIfMemoryBackendEphemeral(null, { warn: () => {} }), false);
  });

  it('reports no warning when the sink cannot warn', () => {
    const dir = tmpDir();
    const store = new MemoryStore({ memoryPath: path.join(dir, 'memory.json') });
    assert.strictEqual(store._storePort.backend(), 'memory');
    // A missing or warn-less sink means nothing was emitted; the return value
    // must say so rather than claim a warning that never reached the operator.
    assert.strictEqual(warnIfMemoryBackendEphemeral({ memory: store, graph: {} }, {}), false);
    assert.strictEqual(warnIfMemoryBackendEphemeral({ memory: store, graph: {} }, null), false);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('memory-store mutations report persistence honestly (#4558)', () => {
  it('the process-only backend tags success as not persistent', () => {
    const store = new MemoryStore({});
    const stored = store.store({ content: { text: 'kayıt' }, actor: 'test' });

    assert.strictEqual(stored.ok, true, 'the write still succeeds in-process');
    assert.strictEqual(stored.persistent, false);
    assert.strictEqual(stored.backend, 'memory');
  });

  it('a durable backend tags success as persistent', () => {
    const dir = tmpDir();
    const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 'memory.db') });
    const stored = store.store({ content: { text: 'kalıcı' }, actor: 'test' });

    assert.strictEqual(stored.ok, true);
    assert.strictEqual(stored.persistent, true);
    assert.strictEqual(stored.backend, 'sqlite');

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed write keeps its shape and gains no persistence claim', () => {
    const store = new MemoryStore({});
    const rejected = store.store({ content: null, actor: 'test' });

    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.persistent, undefined, 'a rejection must not carry a persistence verdict');
  });

  it('link and supersede successes carry the same tag', () => {
    const store = new MemoryStore({});
    const first = store.store({ content: { text: 'bir' }, actor: 'test' });
    const second = store.store({ content: { text: 'iki' }, actor: 'test' });

    const linked = store.linkMemories({
      fromMemoryId: first.memory.memoryId,
      toMemoryId: second.memory.memoryId,
      relation: 'related_to',
      actor: 'test',
    });
    assert.strictEqual(linked.ok, true);
    assert.strictEqual(linked.persistent, false);
    assert.strictEqual(linked.backend, 'memory');

    const superseded = store.supersede(first.memory.memoryId, { text: 'yeni' }, { actor: 'test' });
    assert.strictEqual(superseded.ok, true);
    assert.strictEqual(superseded.persistent, false);
    assert.strictEqual(superseded.backend, 'memory');
  });
});
