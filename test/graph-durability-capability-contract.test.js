'use strict';

/**
 * Durable-mutation capability detection — characterization contract.
 *
 * `mcpServer.js` binds `mutationOperationId` (and therefore the crash-safe
 * mutation journal) only when it believes the Graph can journal. Today it
 * decides that with:
 *
 *   typeof kernel.graph.runMutationOnce === 'function' &&
 *   kernel.graph.getStats().backend === 'sqlite'
 *
 * The first half is not a capability signal. `runMutationOnce` is present on
 * both backends; on the JSON backend it exists and throws when called. So the
 * only thing actually discriminating is the adapter's brand name, `'sqlite'`.
 *
 * That is the REFACTOR-4E violation in its smallest form: a transport surface
 * asks an adapter *what it is* instead of *what it can do*. A future backend
 * that can journal — the Rust graph, another SQL engine — would be refused
 * until someone edits `mcpServer.js`.
 *
 * These tests pin the current facts so that refactor cannot move by accident:
 *   - SQLite journals and de-duplicates replay;
 *   - JSON exposes the method and refuses at call time, with a stated reason;
 *   - method presence therefore proves nothing, and is asserted to prove
 *     nothing, so no future capability check may be built on it.
 *
 * When 4E introduces a real capability query, this file is where its contract
 * belongs: the backend-name check should disappear and the behavioural
 * assertions below should keep passing unchanged.
 *
 * Test-only. No runtime behaviour is added or changed.
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

test('JSON backend reports itself and refuses to journal, stating why', () => {
  const graph = makeGraph('json-journal', false);
  assert.strictEqual(graph.getStats().backend, 'json');

  let calls = 0;
  assert.throws(
    () => graph.runMutationOnce('capability-probe', () => { calls += 1; return { learned: 1 }; }),
    (error) => {
      assert.match(
        error.message,
        /SQLite/i,
        'refusal must name the backend requirement rather than failing opaquely'
      );
      // The refusal is already typed. A capability port introduced by
      // REFACTOR-4E should key on this code rather than on the backend name,
      // so it is pinned here as a stable surface.
      assert.strictEqual(
        error.code,
        'DURABLE_MUTATION_JOURNAL_UNAVAILABLE',
        'refusal must carry a stable machine-readable code'
      );
      return true;
    }
  );

  assert.strictEqual(calls, 0, 'a refused journal must not run the mutation body');
});

test('method presence does not indicate durability support on either backend', () => {
  // This is the load-bearing assertion. `mcpServer.js` pairs a
  // `typeof … === 'function'` check with a backend-name check; the first half
  // is satisfied by both backends and therefore carries no information.
  //
  // Locking it here means a future capability check cannot quietly be built on
  // method presence: if someone drops the backend-name half and keeps the
  // typeof half, durability would silently be assumed on JSON.
  const sqliteGraph = makeGraph('presence-sqlite', true);
  const jsonGraph = makeGraph('presence-json', false);

  assert.strictEqual(typeof sqliteGraph.runMutationOnce, 'function');
  assert.strictEqual(
    typeof jsonGraph.runMutationOnce,
    'function',
    'JSON also exposes the method — presence is not a capability signal'
  );

  assert.strictEqual(
    typeof sqliteGraph.runMutationOnce,
    typeof jsonGraph.runMutationOnce,
    'both backends expose the method identically, so presence cannot discriminate'
  );

  // The behavioural difference is real even though the shape is identical.
  assert.notStrictEqual(
    sqliteGraph.getStats().backend,
    jsonGraph.getStats().backend,
    'only the reported backend currently distinguishes them'
  );
});

test('durability is a property of the backend, not of the call site', () => {
  // Whatever REFACTOR-4E introduces, this must stay true: a Graph that
  // accepts a journalled mutation must de-duplicate replays of it, and a Graph
  // that refuses must refuse before running the body. Any capability port
  // added later has to preserve both halves.
  for (const { name, useSQLite, journals } of [
    { name: 'contract-sqlite', useSQLite: true, journals: true },
    { name: 'contract-json', useSQLite: false, journals: false },
  ]) {
    const graph = makeGraph(name, useSQLite);
    let calls = 0;
    const mutate = () => { calls += 1; return { learned: 1 }; };

    if (journals) {
      graph.runMutationOnce('contract', mutate);
      graph.runMutationOnce('contract', mutate);
      assert.strictEqual(calls, 1, `${name}: journalled mutation must run once across replays`);
    } else {
      assert.throws(() => graph.runMutationOnce('contract', mutate));
      assert.strictEqual(calls, 0, `${name}: refused mutation must not run at all`);
    }
  }
});
