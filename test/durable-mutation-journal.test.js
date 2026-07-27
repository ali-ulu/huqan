'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Graph = require('../graph');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-durable-journal-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

function makeGraph(name) {
  return new Graph({
    memoryPath: path.join(root, `${name}.json`),
    dbPath: path.join(root, `${name}.db`),
    useSQLite: true,
  });
}

test('durable journal commits graph mutation, audit and result once', () => {
  const graph = makeGraph('once');
  let calls = 0;
  const mutate = () => {
    calls += 1;
    graph.addNode('cat', 'Cat', null, { workspaceId: 'w' });
    graph.addNode('animal', 'Animal', null, { workspaceId: 'w' });
    graph.addEdge('cat', 'animal', 'is_a', { workspaceId: 'w' });
    graph.appendAuditEvent({ eventType: 'LEARN', targetType: 'edge', targetId: 'cat|is_a|animal' }, { workspaceId: 'w' });
    return { learned: 1, evidence: ['cat|is_a|animal'] };
  };

  const first = graph.runMutationOnce('approval-1', mutate);
  const second = graph.runMutationOnce('approval-1', mutate);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(calls, 1);
  assert.equal(Object.keys(graph.getNodes('w')).length, 2);
  assert.equal(graph.getEdges('cat', 'w').length, 1);
  assert.equal(graph.getAuditEvents({ workspaceId: 'w' }).length, 1);

  const reloaded = makeGraph('once');
  reloaded.load();
  const replayAfterRestart = reloaded.runMutationOnce('approval-1', () => {
    throw new Error('must not execute after restart');
  });
  assert.equal(replayAfterRestart.replayed, true);
  assert.deepEqual(replayAfterRestart.result, first.result);
});

test('durable journal restores in-memory state when callback rolls back', () => {
  const graph = makeGraph('rollback');
  assert.throws(() => graph.runMutationOnce('approval-rollback', () => {
    graph.addNode('phantom', 'Phantom', null, { workspaceId: 'w' });
    graph.appendAuditEvent({ eventType: 'LEARN', targetType: 'node', targetId: 'phantom' }, { workspaceId: 'w' });
    throw new Error('forced failure');
  }), /forced failure/);

  assert.equal(graph.getNode('phantom', 'w'), null);
  assert.equal(graph.getAuditEvents({ workspaceId: 'w' }).length, 0);
  const retry = graph.runMutationOnce('approval-rollback', () => ({ learned: 0 }));
  assert.equal(retry.replayed, false);
});

test('durable journal fails closed without SQLite', () => {
  const graph = new Graph({ memoryPath: path.join(root, 'json-only.json'), useSQLite: false });
  assert.throws(
    () => graph.runMutationOnce('approval-json', () => ({ learned: 1 })),
    (error) => error && error.code === 'DURABLE_MUTATION_JOURNAL_UNAVAILABLE',
  );
});
