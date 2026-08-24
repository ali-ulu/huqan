'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const Kernel = require('../kernel');
const MemoryStore = require('../lib/memory-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-memory-json-'));
}

function close(store) {
  if (store && typeof store.close === 'function') store.close();
}

test('JSON MemoryStore persists every mutation and reloads it with validation', () => {
  const dir = tempDir();
  const memoryPath = path.join(dir, 'managed-memory.json');
  const writer = new MemoryStore({ useSQLite: false, memoryPath });

  try {
    const first = writer.store({ content: 'ilk sürüm', workspaceId: 'ws-a', metadata: { source: 'test' } }).memory;
    const second = writer.store({ content: 'ikinci kayıt', workspaceId: 'ws-a' }).memory;
    assert.equal(writer.patchMetadata(first.memoryId, { reviewed: true }, { workspaceId: 'ws-a' }).ok, true);
    assert.equal(writer.linkMemories({
      fromMemoryId: first.memoryId,
      toMemoryId: second.memoryId,
      relation: 'supports',
      workspaceId: 'ws-a',
    }).ok, true);
    const replacement = writer.supersede(first.memoryId, 'güncellenmiş sürüm', { workspaceId: 'ws-a' });
    assert.equal(replacement.ok, true);
    assert.equal(writer.tombstone(second.memoryId, { workspaceId: 'ws-a' }).ok, true);

    const saved = writer.save();
    assert.equal(saved.ok, true);
    assert.equal(saved.persistent, true);
    assert.equal(saved.backend, 'json');
    assert.equal(saved.skipped, false);
    assert.ok(fs.existsSync(memoryPath));
  } finally {
    close(writer);
  }

  const reader = new MemoryStore({ useSQLite: false, memoryPath });
  try {
    assert.equal(reader.get('__missing__', { workspaceId: 'ws-a' }).ok, false);
    const records = reader.list({ workspaceId: 'ws-a', includeTombstoned: true });
    assert.equal(records.ok, true);
    assert.equal(records.total, 3);
    assert.equal(records.memories.filter((record) => record.status === 'deleted').length, 1);
    assert.equal(records.memories.filter((record) => record.status === 'superseded').length, 1);
    assert.equal(records.memories.find((record) => record.status === 'superseded').metadata.reviewed, true);
    assert.equal(reader.queryLinks({ workspaceId: 'ws-a', includeDeleted: true }).total, 2);
    assert.equal(reader.timeline({ workspaceId: 'ws-a' }).total, 7);
    assert.equal(reader.load().backend, 'json');
    assert.equal(reader.load().skipped, false);
  } finally {
    close(reader);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('JSON MemoryStore imports a package durably, including events and links', () => {
  const dir = tempDir();
  const source = new MemoryStore({ useSQLite: false });
  const memoryPath = path.join(dir, 'target.json');
  const target = new MemoryStore({ useSQLite: false, memoryPath });

  try {
    const first = source.store({ content: 'paket bir', workspaceId: 'source' }).memory;
    const second = source.store({ content: 'paket iki', workspaceId: 'source' }).memory;
    assert.equal(source.linkMemories({
      fromMemoryId: first.memoryId,
      toMemoryId: second.memoryId,
      relation: 'references',
      workspaceId: 'source',
    }).ok, true);
    const pkg = source.exportPackage({ workspaceId: 'source', includeTombstoned: true });
    assert.equal(pkg.ok, true);

    const imported = target.importPackage(pkg.package, { targetWorkspaceId: 'target' });
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.imported, { memories: 2, events: 3, links: 1 });
  } finally {
    close(source);
    close(target);
  }

  const reader = new MemoryStore({ useSQLite: false, memoryPath });
  try {
    assert.equal(reader.list({ workspaceId: 'target' }).total, 2);
    assert.equal(reader.timeline({ workspaceId: 'target' }).total, 3);
    assert.equal(reader.queryLinks({ workspaceId: 'target' }).total, 1);
  } finally {
    close(reader);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON MemoryStore refuses malformed persisted state', () => {
  const dir = tempDir();
  const memoryPath = path.join(dir, 'broken.json');
  fs.writeFileSync(memoryPath, '{not-json', 'utf8');

  try {
    assert.throws(
      () => new MemoryStore({ useSQLite: false, memoryPath }),
      (error) => error && error.code === 'MEMORY_STORE_JSON_INVALID',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Kernel derives a separate JSON path for managed memory', () => {
  const dir = tempDir();
  const graphPath = path.join(dir, 'graph.json');
  const writer = new Kernel({ noLoad: true, useSQLite: false, memoryPath: graphPath, loadPlugins: false });

  try {
    const stored = writer.memory.store({ content: 'kernel memory', workspaceId: 'default' });
    assert.equal(stored.ok, true);
    assert.notEqual(writer.memory._jsonPath, graphPath);
    assert.ok(fs.existsSync(writer.memory._jsonPath));
  } finally {
    writer.graph.close();
  }

  const reader = new Kernel({ useSQLite: false, memoryPath: graphPath, loadPlugins: false });
  try {
    assert.equal(reader.memory.list({ workspaceId: 'default' }).total, 1);
  } finally {
    reader.graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
