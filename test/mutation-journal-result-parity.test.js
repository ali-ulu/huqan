'use strict';

/**
 * The committed-mutation readers must return the same shape on both backends.
 *
 * #1262 reported that the JSON path returns `result` as a raw string while the
 * SQLite path returns an object, so a caller reading `result.memoryId` would
 * get `undefined` on one of them. It does not: the JSON journal stores the
 * result object and the journal file is parsed as JSON when read, so
 * `row.result` is already an object. Only the SQLite path stores a string, and
 * that is exactly why it calls JSON.parse.
 *
 * These tests keep the parity settled by execution rather than by reading the
 * two branches side by side, and they fail if either backend starts handing
 * back the other shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Graph = require('../graph');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-journal-parity-'));

let counter = 0;
function makeGraph(useSQLite) {
  counter += 1;
  return new Graph({
    noLoad: true,
    useSQLite,
    memoryPath: path.join(tempDir, `journal-${counter}.json`),
    dbPath: path.join(tempDir, `journal-${counter}.db`),
  });
}

function sqliteAvailable() {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch (_) {
    return false;
  }
}

const RESULT = { memoryId: 'mem-9', count: 3, nested: { ok: true } };

function committedGraph(useSQLite) {
  const graph = makeGraph(useSQLite);
  graph.runMutationOnce('op-parity-1', () => ({ ...RESULT }));
  return graph;
}

test('the JSON backend returns result as a readable object', () => {
  const graph = committedGraph(false);

  const committed = graph.getCommittedMutationResultByOperation('op-parity-1');

  assert.equal(typeof committed.result, 'object');
  assert.deepEqual(committed.result, RESULT);
  assert.equal(committed.result.memoryId, 'mem-9', 'field access must work, not return undefined');
});

test('the SQLite backend returns the same shape', (t) => {
  if (!sqliteAvailable()) return t.skip('better-sqlite3 is unavailable');
  const graph = committedGraph(true);

  const committed = graph.getCommittedMutationResultByOperation('op-parity-1');

  assert.equal(typeof committed.result, 'object');
  assert.deepEqual(committed.result, RESULT);
});

test('the prefix reader agrees with the single reader on the JSON backend', () => {
  const graph = committedGraph(false);

  const [listed] = graph.getCommittedMutationResultsByPrefix('op-parity-');

  assert.equal(typeof listed.result, 'object');
  assert.deepEqual(listed.result, RESULT);
});

test('the prefix reader agrees on the SQLite backend too', (t) => {
  if (!sqliteAvailable()) return t.skip('better-sqlite3 is unavailable');
  const graph = committedGraph(true);

  const [listed] = graph.getCommittedMutationResultsByPrefix('op-parity-');

  assert.equal(typeof listed.result, 'object');
  assert.deepEqual(listed.result, RESULT);
});

test('an unknown operation reads as absent on both backends', (t) => {
  assert.equal(makeGraph(false).getCommittedMutationResultByOperation('op-missing'), null);
  if (!sqliteAvailable()) return t.skip('better-sqlite3 is unavailable');
  assert.equal(makeGraph(true).getCommittedMutationResultByOperation('op-missing'), null);
});
