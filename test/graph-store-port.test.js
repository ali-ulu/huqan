'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');

test('Graph exposes a frozen persistence port and preserves JSON save/load behavior', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-store-port-'));

  const memoryPath = path.join(root, 'memory.json');
  const first = new Graph({ memoryPath, useSQLite: false });
  let second;
  t.after(() => {
    first.close();
    second?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(Object.isFrozen(first._storePort), true);
  for (const method of ['stripEmbeddings', 'restoreEmbeddings', 'save', 'writeStrippedState', 'load']) {
    assert.equal(typeof first._storePort[method], 'function', `port must implement ${method}`);
  }

  first.addNode('persisted', 'Persisted node', null, { workspaceId: 'workspace-a' });
  first.save();

  second = new Graph({ memoryPath, useSQLite: false });
  second.load();

  assert.equal(second.getNode('persisted', { workspaceId: 'workspace-a' }).label, 'Persisted node');
  assert.deepEqual(JSON.parse(fs.readFileSync(memoryPath, 'utf8')).nodes['workspace-a::persisted'].id, 'persisted');
});

test('GraphStorePort preserves SQLite save/load behavior when SQLite is available', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-store-port-sqlite-'));

  const options = {
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  };
  const first = new Graph(options);
  let second;
  t.after(() => {
    first.close();
    second?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (first.getStats().backend !== 'sqlite') {
    t.skip('better-sqlite3 is unavailable');
    return;
  }

  first.addNode('persisted', 'SQLite node', null, { workspaceId: 'workspace-b' });
  first.save();

  second = new Graph(options);
  second.load();
  assert.equal(second.getNode('persisted', { workspaceId: 'workspace-b' }).label, 'SQLite node');
});
