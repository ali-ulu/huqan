'use strict';

/**
 * #1135/#1711: graph, embedding sidecar and journal form one recoverable JSON
 * transaction. Once prepared, a retry completes the recorded after-images and
 * replays the canonical result without invoking the mutation again.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Graph = require('../graph');
const { readMutationJournal } = require('../lib/mutation-journal');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-json-commit-order-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

let seq = 0;
function makeGraph(name) {
  seq += 1;
  const memoryPath = path.join(root, `${name}-${seq}.json`);
  return {
    graph: new Graph({ memoryPath, useSQLite: false, noLoad: true }),
    memoryPath,
    journalPath: memoryPath.replace(/\.json$/, '.mutations.json'),
  };
}

function journalStatus(journalPath, operationId) {
  if (!fs.existsSync(journalPath)) return null;
  const op = readMutationJournal(journalPath).operations[operationId];
  return op ? op.status : null;
}

test('#1135 a prepared transaction recovers without double-applying', () => {
  const { graph, memoryPath, journalPath } = makeGraph('crash-window');
  graph._jsonTransactionFault = point => {
    if (point === 'after-graph-publish') throw new Error('process died');
  };

  let applications = 0;
  const mutate = () => {
    applications += 1;
    graph.addNode('cat', 'cat', null, { workspaceId: 'w' });
    return { applied: applications };
  };

  assert.throws(() => graph.runMutationOnce('op-1', mutate), /process died/);

  assert.equal(applications, 1);
  assert.equal(journalStatus(journalPath, 'op-1'), null, 'the journal must not claim completion');
  const restarted = new Graph({ memoryPath, useSQLite: false, noLoad: true });
  const retry = restarted.runMutationOnce('op-1', () => {
    applications += 1;
    throw new Error('must not execute');
  });
  assert.equal(retry.replayed, true);
  assert.equal(applications, 1);
  assert.equal(journalStatus(journalPath, 'op-1'), 'completed');
  assert.equal(retry.result.applied, 1);
});

test('#1135 a failing save() never leaves a completed journal entry behind', () => {
  const { graph, journalPath } = makeGraph('save-fails');

  let failPrepare = true;
  graph._jsonTransactionFault = point => {
    if (failPrepare && point === 'before-prepared') throw new Error('disk full');
  };

  let applications = 0;
  const mutate = () => {
    applications += 1;
    graph.addNode('cat', 'cat', null, { workspaceId: 'w' });
    return { applied: applications };
  };

  assert.throws(() => graph.runMutationOnce('op-2', mutate), /disk full/);

  // This is the failure mode the ordering exists to prevent: no completion is
  // recorded for state that never reached disk, and in-memory state is rolled
  // back to match.
  assert.equal(journalStatus(journalPath, 'op-2'), null, 'no phantom completion');
  assert.equal(Object.keys(graph.getNodes('w')).length, 0, 'in-memory state rolled back');

  // The retry therefore applies exactly once in total — no loss, no duplicate.
  failPrepare = false;
  const retry = graph.runMutationOnce('op-2', mutate);

  assert.equal(retry.replayed, false);
  assert.equal(applications, 2, 'mutate() ran twice, but only the second one committed');
  assert.equal(retry.result.applied, 2);
  assert.equal(Object.keys(graph.getNodes('w')).length, 1);
  assert.equal(journalStatus(journalPath, 'op-2'), 'completed');
});

test('#1135 a completed operation replays without re-running the mutation', () => {
  const { graph, journalPath } = makeGraph('replay');

  let applications = 0;
  const mutate = () => {
    applications += 1;
    graph.addNode('cat', 'cat', null, { workspaceId: 'w' });
    return { applied: applications };
  };

  const first = graph.runMutationOnce('op-3', mutate);
  const second = graph.runMutationOnce('op-3', mutate);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(applications, 1, 'the whole point of the journal: no re-run once completed');
  assert.deepEqual(second.result, first.result);
  assert.equal(journalStatus(journalPath, 'op-3'), 'completed');
});
