'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Graph } = require('../graph');
const { normalizeNodeLabel, normalizeNodeRecord } = require('../lib/graph-record-utils');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-node-label-'));
}

describe('Node label normalization (#1027)', () => {
  it('normalizeNodeLabel falls back to the id only for a blank label', () => {
    assert.strictEqual(normalizeNodeLabel('Kedi', 'kedi'), 'Kedi');
    assert.strictEqual(normalizeNodeLabel(undefined, 'kedi'), 'kedi');
    assert.strictEqual(normalizeNodeLabel(null, 'kedi'), 'kedi');
    assert.strictEqual(normalizeNodeLabel('', 'kedi'), 'kedi');
    assert.strictEqual(normalizeNodeLabel('   ', 'kedi'), 'kedi');
    // Whitespace inside a real label is left alone.
    assert.strictEqual(normalizeNodeLabel(' Kara Kedi ', 'kedi'), ' Kara Kedi ');
  });

  it('both backends answer a missing label identically', () => {
    // nodes.label is NOT NULL, so SQLite used to throw a raw SqliteError while
    // the JSON backend stored a record with no label key at all — and graph.js
    // falls back to JSON silently when better-sqlite3 will not load, so the
    // same input threw on one machine and succeeded on another.
    const dir = tmpDir();

    const jsonGraph = new Graph({ memoryPath: path.join(dir, 'json.json'), useSQLite: false });
    const jsonNode = jsonGraph.addNode('a');

    const sqliteGraph = new Graph({ memoryPath: path.join(dir, 'sqlite.json'), useSQLite: true });
    const sqliteNode = sqliteGraph.addNode('a');

    assert.strictEqual(jsonNode.label, 'a');
    assert.strictEqual(sqliteNode.label, 'a');
    assert.strictEqual(jsonNode.label, sqliteNode.label);

    sqliteGraph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an explicit label is never rewritten', () => {
    const dir = tmpDir();
    const graph = new Graph({ memoryPath: path.join(dir, 'memory.json'), useSQLite: true });

    assert.strictEqual(graph.addNode('kedi', 'Kedi').label, 'Kedi');
    // Re-adding an existing node keeps updating the label, as before.
    assert.strictEqual(graph.addNode('kedi', 'Kara Kedi').label, 'Kara Kedi');
    // ...but a blank label on an existing node falls back rather than storing ''.
    assert.strictEqual(graph.addNode('kedi', '  ').label, 'kedi');

    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a label-less record already on disk survives the JSON -> SQLite migration', () => {
    // load() ends with `if (this._db && ...) this.save()`. A record written by
    // the JSON backend before the write path normalized has no label, so that
    // migration hit the NOT NULL constraint — far from where the record was
    // produced, and swallowed as a logged "Load error" rather than surfaced.
    const dir = tmpDir();
    const memoryPath = path.join(dir, 'memory.json');
    fs.writeFileSync(memoryPath, JSON.stringify({
      nodes: {
        'a::default': {
          id: 'a',
          tags: [],
          vector: {},
          weight: 0.5,
          workspaceId: 'default',
          created: Date.now(),
          created_at: new Date().toISOString(),
          lastAccessed: Date.now(),
          lastSeen: new Date().toISOString(),
          last_seen: new Date().toISOString(),
          provenance: null,
        },
      },
      edges: [],
    }));

    const graph = new Graph({ memoryPath, useSQLite: true });
    graph.load();

    assert.strictEqual(graph.getNode('a').label, 'a', 'the node must survive the load');
    const row = graph._db.prepare('SELECT label FROM nodes WHERE id = ?').get('a');
    assert.ok(row, 'and must reach the database');
    assert.strictEqual(row.label, 'a');

    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('normalizeNodeRecord repairs a missing label from the id', () => {
    assert.strictEqual(normalizeNodeRecord({ id: 'a' }).label, 'a');
    assert.strictEqual(normalizeNodeRecord({ id: 'a', label: 'A' }).label, 'A');
    // nodeStorageKey() is `workspaceId::id`, and a bare id in the default
    // workspace, so the fallback takes the last segment.
    assert.strictEqual(normalizeNodeRecord({}, 'kedi').label, 'kedi');
    assert.strictEqual(normalizeNodeRecord({}, 'acme::kedi').label, 'kedi');
  });
});
