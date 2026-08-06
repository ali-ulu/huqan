'use strict';

/**
 * Durable-mutation capability detection - characterization contract.
 *
 * #216 closed the REFACTOR-4E gap this file originally pinned: `mcpServer.js`
 * used to bind `mutationOperationId` only when `kernel.graph.getStats().backend
 * === 'sqlite'`, because `runMutationOnce` existed on the JSON backend but
 * always threw `DURABLE_MUTATION_JOURNAL_UNAVAILABLE`. Method presence was
 * therefore not a capability signal -- only the backend's brand name was.
 *
 * The JSON backend now has its own real durable mutation journal (a sibling
 * `*.mutations.json` file, written atomically, with the same idempotent-replay,
 * rollback-on-error, and hash-chained-receipt guarantees as SQLite -- see
 * `graph.js` `_runMutationOnceJson` and `test/durable-mutation-journal.test.js`
 * for the parity proof). `mcpServer.js` now binds `mutationOperationId`
 * whenever `runMutationOnce` is present, with no backend-name check, because
 * presence now genuinely means "this backend journals."
 *
 * This file keeps pinning the property that matters: durability is a
 * property of the backend's *behavior*, not of its name -- it just no
 * longer needs a name-based capability check to get there, because both
 * backends now behave the same way.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Graph = require('../graph');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-durability-capability-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

function makeGraph(name, useSQLite) {
  return new Graph({
    memoryPath: path.join(root, `${name}.json`),
    dbPath: path.join(root, `${name}.db`),
    useSQLite,
  });
}

test('SQLite backend reports itself and journals a mutation exactly once', () => {
  const graph = makeGraph('sqlite-journal', true);
  assert.strictEqual(graph.getStats().backend, 'sqlite');

  let calls = 0;
  const mutate = () => {
    calls += 1;
    graph.addNode('cat', 'Cat', null, { workspaceId: 'w' });
    return { learned: 1 };
  };

  const first = graph.runMutationOnce('capability-probe', mutate);
  const second = graph.runMutationOnce('capability-probe', mutate);

  assert.strictEqual(first.replayed, false, 'first call must execute');
  assert.strictEqual(second.replayed, true, 'second call must be recognised as replay');
  assert.deepEqual(second.result, first.result, 'replay must return the recorded result');
  assert.strictEqual(calls, 1, 'the mutation body must run exactly once');
});

test('JSON backend reports itself and journals a mutation exactly once (#216 parity)', () => {
  const graph = makeGraph('json-journal', false);
  assert.strictEqual(graph.getStats().backend, 'json');

  let calls = 0;
  const mutate = () => {
    calls += 1;
    graph.addNode('cat', 'Cat', null, { workspaceId: 'w' });
    return { learned: 1 };
  };

  const first = graph.runMutationOnce('capability-probe', mutate);
  const second = graph.runMutationOnce('capability-probe', mutate);

  assert.strictEqual(first.replayed, false, 'first call must execute');
  assert.strictEqual(second.replayed, true, 'second call must be recognised as replay');
  assert.deepEqual(second.result, first.result, 'replay must return the recorded result');
  assert.strictEqual(calls, 1, 'the mutation body must run exactly once');
});

test('method presence is now a genuine capability signal on both backends', () => {
  // Before #216 this was the load-bearing "presence proves nothing"
  // assertion. It now proves the opposite: since both backends behave
  // identically (idempotent journal), a caller may safely key off
  // `typeof graph.runMutationOnce === 'function'` alone, with no
  // backend-name check -- which is exactly what mcpServer.js now does.
  const sqliteGraph = makeGraph('presence-sqlite', true);
  const jsonGraph = makeGraph('presence-json', false);

  assert.strictEqual(typeof sqliteGraph.runMutationOnce, 'function');
  assert.strictEqual(typeof jsonGraph.runMutationOnce, 'function');

  let sqliteCalls = 0;
  let jsonCalls = 0;
  sqliteGraph.runMutationOnce('probe', () => { sqliteCalls += 1; return { ok: true }; });
  sqliteGraph.runMutationOnce('probe', () => { sqliteCalls += 1; return { ok: true }; });
  jsonGraph.runMutationOnce('probe', () => { jsonCalls += 1; return { ok: true }; });
  jsonGraph.runMutationOnce('probe', () => { jsonCalls += 1; return { ok: true }; });

  assert.strictEqual(sqliteCalls, 1, 'sqlite: presence-based caller gets real idempotent replay');
  assert.strictEqual(jsonCalls, 1, 'json: presence-based caller gets real idempotent replay too');
});

test('durability is a property of the backend, and both backends now provide it', () => {
  for (const { name, useSQLite } of [
    { name: 'contract-sqlite', useSQLite: true },
    { name: 'contract-json', useSQLite: false },
  ]) {
    const graph = makeGraph(name, useSQLite);
    let calls = 0;
    const mutate = () => { calls += 1; return { learned: 1 }; };

    graph.runMutationOnce('contract', mutate);
    graph.runMutationOnce('contract', mutate);
    assert.strictEqual(calls, 1, `${name}: journalled mutation must run once across replays`);
  }
});
