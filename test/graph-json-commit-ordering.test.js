'use strict';

/**
 * #1135: the JSON backend's commit ordering, pinned by test.
 *
 * _runMutationOnceJsonLocked() persists graph state with save() and only then
 * marks the journal 'completed'. The comment above those two lines documents
 * the choice and its cost:
 *
 *   - save() first  -> a crash in between double-applies on retry
 *   - journal first -> a crash in between claims success for data that was
 *                      never persisted (phantom completion)
 *
 * The tradeoff was argued in a comment and asserted nowhere, so nothing stopped
 * a later edit from reversing the two lines and silently buying the worse
 * failure. These tests drive both sides of the window directly: one proves the
 * accepted cost is the one actually paid, the other proves the failure that was
 * traded away stays traded away.
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

test('#1135 a crash between save() and the journal write re-runs the mutation on retry', () => {
  const { graph, journalPath } = makeGraph('crash-window');

  // The crash window: save() has already landed, the journal write has not.
  const realWriteJournal = graph._writeJsonJournal.bind(graph);
  let crashOnJournalWrite = true;
  graph._writeJsonJournal = (journal) => {
    if (crashOnJournalWrite) throw new Error('process died before the journal was written');
    return realWriteJournal(journal);
  };

  let applications = 0;
  const mutate = () => {
    applications += 1;
    graph.addNode('cat', 'cat', null, { workspaceId: 'w' });
    return { applied: applications };
  };

  assert.throws(() => graph.runMutationOnce('op-1', mutate), /process died/);

  // Ordering guarantee: the mutation reached disk, the journal did not record
  // it. That asymmetry is the whole point of putting save() first.
  assert.equal(applications, 1);
  assert.equal(journalStatus(journalPath, 'op-1'), null, 'the journal must not claim completion');

  // The cost of that choice, made explicit: the same operationId is not
  // recognized as a replay, so the mutation runs a second time.
  crashOnJournalWrite = false;
  const retry = graph.runMutationOnce('op-1', mutate);

  assert.equal(retry.replayed, false, 'a crashed operation is not recognized as completed');
  assert.equal(applications, 2, 'this is the accepted double-apply, not a regression');
  assert.equal(journalStatus(journalPath, 'op-1'), 'completed');

  // And why it is the lesser evil: nothing was ever reported as done that was
  // not on disk. Both applications really happened.
  assert.equal(retry.result.applied, 2);
});

test('#1135 a failing save() never leaves a completed journal entry behind', () => {
  const { graph, journalPath } = makeGraph('save-fails');

  const realSave = graph.save.bind(graph);
  let failSave = true;
  graph.save = (...args) => {
    if (failSave) throw new Error('disk full');
    return realSave(...args);
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
  failSave = false;
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
