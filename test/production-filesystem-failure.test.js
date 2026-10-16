'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const { MUTATION_JOURNAL_CORRUPT } = require('../lib/mutation-journal');

function makeTempPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    memoryPath: path.join(root, 'memory.json'),
    journalPath: path.join(root, 'memory.mutations.json'),
    dbPath: path.join(root, 'memory.db'),
  };
}

function removeTempRoot(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

test('JSON mutation fails closed when the persistence directory is read-only', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX directory permission semantics are required');
  const { root, memoryPath, journalPath } = makeTempPaths('huqan-fs-readonly-');
  const graph = new Graph({ memoryPath, useSQLite: false });
  try {
    fs.chmodSync(root, 0o555);
    assert.throws(
      () => graph.runMutationOnce('readonly-operation', () => {
        graph.addNode('must-not-persist', 'read-only write');
        return { applied: true };
      }),
      (error) => /EACCES|EPERM|permission denied|not permitted/i.test(error.message),
    );
    assert.equal(graph.getNode('must-not-persist'), null);
    assert.equal(fs.existsSync(memoryPath), false);
    assert.equal(fs.existsSync(journalPath), false);
  } finally {
    fs.chmodSync(root, 0o755);
    graph.close?.();
    removeTempRoot(root);
  }
});

test('a truncated JSON mutation journal refuses mutation instead of resetting history', () => {
  const { root, memoryPath, journalPath } = makeTempPaths('huqan-fs-journal-corrupt-');
  fs.writeFileSync(journalPath, '{"operations":');
  const graph = new Graph({ memoryPath, useSQLite: false });
  try {
    assert.throws(
      () => graph.runMutationOnce('corrupt-journal-operation', () => {
        graph.addNode('must-not-run', 'corrupt journal');
        return { applied: true };
      }),
      (error) => error?.code === MUTATION_JOURNAL_CORRUPT,
    );
    assert.equal(graph.getNode('must-not-run'), null);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), '{"operations":');
  } finally {
    graph.close?.();
    removeTempRoot(root);
  }
});

test('an existing corrupt SQLite file fails closed during initialization', (t) => {
  const { root, memoryPath, dbPath } = makeTempPaths('huqan-fs-sqlite-corrupt-');
  fs.writeFileSync(dbPath, 'not a SQLite database');
  try {
    assert.throws(
      () => new Graph({ memoryPath, dbPath, useSQLite: true }),
      (error) => error?.code === 'SQLITE_PERSISTENCE_INIT_FAILED',
    );
  } finally {
    removeTempRoot(root);
  }
});
