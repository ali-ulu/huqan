'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-kernel-persistence-roundtrip-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // Best effort only. Temp files are outside the repo.
  }
});

function makePaths(label) {
  return {
    memoryPath: path.join(tempDir, `${label}.json`),
    dbPath: path.join(tempDir, `${label}.db`),
  };
}

function closeKernel(kernel) {
  if (kernel && kernel.graph && typeof kernel.graph.close === 'function') {
    kernel.graph.close();
  }
}

test('kernel.learn auto-saves and fresh Kernel auto-loads with JSON backend', () => {
  const paths = makePaths('json-auto-roundtrip');
  const writer = new Kernel({
    noLoad: true,
    useSQLite: false,
    ...paths,
  });

  try {
    const learn = writer.learn('ankara baskenttir', { workspaceId: 'default' });
    assert.equal(learn.ok, true);

    const persistedJson = JSON.parse(fs.readFileSync(paths.memoryPath, 'utf8'));
    assert.ok(persistedJson.nodes);
    assert.ok(Array.isArray(persistedJson.edges));

    const reader = new Kernel({
      noLoad: false,
      useSQLite: false,
      ...paths,
    });

    try {
      const node = reader.graph.getNode('ankara', 'default');
      const edge = reader.graph.getEdge('ankara', 'baskent', 'tür', 'default');

      assert.ok(node, 'fresh Kernel should auto-load persisted node');
      assert.ok(edge, 'fresh Kernel should auto-load persisted edge');
    } finally {
      closeKernel(reader);
    }
  } finally {
    closeKernel(writer);
  }
});

test('kernel.learn auto-saves and fresh Kernel auto-loads with SQLite backend when available', (t) => {
  const paths = makePaths('sqlite-auto-roundtrip');
  const writer = new Kernel({
    noLoad: true,
    useSQLite: true,
    ...paths,
  });

  if (writer.graph.getStats().backend !== 'sqlite') {
    closeKernel(writer);
    return t.skip('better-sqlite3 is unavailable');
  }

  const reader = new Kernel({
    noLoad: false,
    useSQLite: true,
    ...paths,
  });

  if (reader.graph.getStats().backend !== 'sqlite') {
    closeKernel(writer);
    closeKernel(reader);
    return t.skip('better-sqlite3 is unavailable');
  }

  t.after(() => {
    closeKernel(writer);
    closeKernel(reader);
  });

  const learn = writer.learn('izmir sehirdir', { workspaceId: 'default' });
  assert.equal(learn.ok, true);

  reader.graph.load();

  const node = reader.graph.getNode('izmir', 'default');
  const edge = reader.graph.getEdge('izmir', 'sehir', 'tür', 'default');

  assert.ok(node, 'fresh SQLite Kernel should auto-load persisted node');
  assert.ok(edge, 'fresh SQLite Kernel should auto-load persisted edge');
});
