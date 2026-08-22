'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Graph } = require('../graph');
const {
  siblingPersistencePath,
  assertDistinctPersistencePaths,
} = require('../lib/memory-store-utils');
const { resolvePersistencePaths } = require('../persistencePaths');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Persistence path derivation (#1025)', () => {
  it('siblingPersistencePath appends when there is no .json to replace', () => {
    // `base.replace(/\.json$/, suffix)` is a no-op on an extensionless base,
    // which is how three roles ended up on one path.
    assert.strictEqual(siblingPersistencePath('memory.json', '.db'), 'memory.db');
    assert.strictEqual(siblingPersistencePath('memory', '.db'), 'memory.db');
    assert.strictEqual(siblingPersistencePath('/a/b/mem', '.embeddings.json'), '/a/b/mem.embeddings.json');
    assert.strictEqual(siblingPersistencePath('/a/b/mem.json', '.embeddings.json'), '/a/b/mem.embeddings.json');
    // Only the trailing extension is replaced, never one in a directory name.
    assert.strictEqual(siblingPersistencePath('/a.json/mem', '.db'), '/a.json/mem.db');
    // Case-insensitive, matching what _jsonJournalPath() already did.
    assert.strictEqual(siblingPersistencePath('mem.JSON', '.db'), 'mem.db');
  });

  it('an extensionless memoryPath yields three distinct files', () => {
    const dir = tmpDir('huqan-path-derivation-');
    const memoryPath = path.join(dir, 'mem');

    const graph = new Graph({ memoryPath, useSQLite: true });
    assert.notStrictEqual(graph._embeddingPath, graph.memoryPath);
    assert.notStrictEqual(graph._jsonJournalPath(), graph.memoryPath);
    assert.strictEqual(graph._embeddingPath, `${memoryPath}.embeddings.json`);

    graph.addNode('a', 'A');
    graph.save();
    graph.close();

    // The memory file must hold JSON, not a database SQLite opened over it.
    const head = fs.readFileSync(memoryPath, 'utf8').slice(0, 1);
    assert.strictEqual(head, '{', 'memoryPath must contain the JSON memory');
    assert.ok(fs.existsSync(`${memoryPath}.db`), 'the database gets its own path');
    assert.ok(fs.existsSync(`${memoryPath}.embeddings.json`), 'so do the embeddings');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an extensionless memoryPath survives a save and reload', () => {
    const dir = tmpDir('huqan-path-roundtrip-');
    const memoryPath = path.join(dir, 'mem');

    const graph = new Graph({ memoryPath, useSQLite: true });
    graph.addNode('kedi', 'Kedi');
    graph.addNode('hayvan', 'Hayvan');
    graph.addEdge('kedi', 'hayvan', 'is_a', { weight: 0.9 });
    graph.save();
    graph.close();

    const reloaded = new Graph({ memoryPath, useSQLite: true });
    reloaded.load();
    assert.ok(reloaded.getNode('kedi'), 'the node must survive');
    assert.ok(reloaded.getEdge('kedi', 'hayvan', 'is_a'), 'and so must the edge');
    reloaded.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a .json memoryPath keeps its existing layout', () => {
    const dir = tmpDir('huqan-path-json-');
    const memoryPath = path.join(dir, 'memory.json');

    const graph = new Graph({ memoryPath, useSQLite: true });
    assert.strictEqual(graph._embeddingPath, path.join(dir, 'memory.embeddings.json'));
    assert.strictEqual(graph._jsonJournalPath(), path.join(dir, 'memory.mutations.json'));
    graph.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a colliding explicit dbPath is refused rather than silently overwritten', () => {
    const dir = tmpDir('huqan-path-collision-');
    const memoryPath = path.join(dir, 'memory.json');

    assert.throws(
      () => new Graph({ memoryPath, dbPath: memoryPath, useSQLite: true }),
      /Persistence paths collide/,
    );

    // The same file named two different ways is still the same file.
    assert.throws(
      () => new Graph({
        memoryPath,
        dbPath: path.join(dir, 'sub', '..', 'memory.json'),
        useSQLite: true,
      }),
      /Persistence paths collide/,
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('assertDistinctPersistencePaths compares resolved paths and ignores blanks', () => {
    assert.throws(
      () => assertDistinctPersistencePaths({ a: './mem.json', b: 'mem.json' }),
      /Persistence paths collide/,
    );
    assert.doesNotThrow(() => assertDistinctPersistencePaths({ a: 'mem.json', b: 'mem.db' }));
    assert.doesNotThrow(() => assertDistinctPersistencePaths({ a: 'mem.json', b: '', c: undefined }));
  });

  it('resolvePersistencePaths derives a distinct dbPath without an extension', () => {
    // The CLI reaches its dbPath through here, and it carried the same no-op
    // replace: an extensionless memoryPath resolved dbPath onto the memory file.
    const dir = tmpDir('huqan-path-resolve-');

    const derived = resolvePersistencePaths({ rootDir: dir, memoryPath: 'mem' });
    assert.notStrictEqual(derived.dbPath, derived.memoryPath);
    assert.strictEqual(derived.dbPath, path.join(dir, 'mem.db'));

    const withExtension = resolvePersistencePaths({ rootDir: dir, memoryPath: 'mem.json' });
    assert.strictEqual(withExtension.dbPath, path.join(dir, 'mem.db'));

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
