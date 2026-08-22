'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const MemoryStore = require('../lib/memory-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-memory-honesty-'));
}

describe('MemoryStore persistence reporting (#1028)', () => {
  it('save() fails closed when there is no durable backend', () => {
    // `ok: true` with `skipped: true` told every caller that reads `.ok` — the
    // ordinary way to read this envelope — that the records were durable, while
    // the process was about to drop them.
    const store = new MemoryStore({ useSQLite: false });
    store.store({ content: { text: 'kalıcı olmalı' }, actor: 'test' });

    const saved = store.save();
    assert.strictEqual(saved.ok, false);
    assert.strictEqual(saved.persistent, false);
    assert.strictEqual(saved.backend, 'memory');
    assert.strictEqual(saved.error.code, 'PERSISTENCE_DISABLED');
    assert.match(saved.error.message, /memoryStoreUseSQLite/);
  });

  it('save() succeeds when a durable backend is wired', () => {
    const dir = tmpDir();
    const store = new MemoryStore({
      memoryStoreUseSQLite: true,
      dbPath: path.join(dir, 'memory.db'),
    });

    const saved = store.save();
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.persistent, true);
    assert.strictEqual(saved.backend, 'sqlite');
    assert.strictEqual(saved.error, undefined);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('load() reports whether the load was real or vacuous', () => {
    const store = new MemoryStore({ useSQLite: false });
    const loaded = store.load();
    // Loading nothing from nowhere genuinely succeeded, but a caller can now
    // tell it apart from a load that had a backend behind it.
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.persistent, false);
    assert.strictEqual(loaded.backend, 'memory');
  });

  it("a default Kernel's memory core admits it is not persistent", () => {
    // Graph is opt-out of SQLite and MemoryStore is opt-in, so one kernel holds
    // two storage layers with opposite defaults. That is out of scope here —
    // what must not happen is the memory core reporting success anyway.
    const dir = tmpDir();
    const kernel = new Kernel({ memoryPath: path.join(dir, 'memory.json'), noLoad: true });

    assert.ok(kernel.graph._db, 'the graph persists by default');
    assert.ok(!kernel.memory._db, 'the memory core does not');

    const stored = kernel.memory.store({ content: { text: 'kayıt' }, actor: 'test' });
    assert.strictEqual(stored.ok, true, 'storing into the process still works');

    const saved = kernel.memory.save();
    assert.strictEqual(saved.ok, false, 'but saving must not claim durability');
    assert.strictEqual(saved.error.code, 'PERSISTENCE_DISABLED');

    kernel.graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
