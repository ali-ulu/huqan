'use strict';

/**
 * #1671: prototype-special operation identifiers must not defeat replay
 * tracking.
 *
 * On a plain `{}` map, `operations['__proto__'] = entry` re-points the
 * prototype instead of creating an own property, so the entry disappears and
 * the same operationId re-executes on the next request -- the exact guarantee
 * runMutationOnce() exists to provide. `constructor` and `toString` fail the
 * other way: an inherited value reads back as if it were a journal row.
 *
 * These tests drive the real journal through Graph, so they fail if the
 * null-prototype sections in lib/mutation-journal.js are replaced with `{}`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Graph = require('../graph');
const {
  emptyMutationJournal,
  readMutationJournal,
  toJournalSection,
} = require('../lib/mutation-journal');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-journal-proto-'));

let counter = 0;
function makeGraph() {
  counter += 1;
  const memoryPath = path.join(tempDir, `proto-${counter}.json`);
  return { graph: new Graph({ noLoad: true, useSQLite: false, memoryPath }), memoryPath };
}

const HOSTILE_IDS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'];

test('every journal section is prototype-free', () => {
  const journal = emptyMutationJournal();
  for (const section of ['operations', 'receipts', 'chainTips', 'receiptsById']) {
    assert.equal(Object.getPrototypeOf(journal[section]), null, `${section} must have no prototype`);
    assert.equal(journal[section].toString, undefined, `${section} must not inherit toString`);
  }
});

for (const operationId of HOSTILE_IDS) {
  test(`a mutation with operationId ${JSON.stringify(operationId)} is journalled and replayed once`, () => {
    const { graph } = makeGraph();
    let runs = 0;
    const mutate = () => {
      runs += 1;
      return { runs };
    };

    const first = graph.runMutationOnce(operationId, mutate);
    assert.equal(first.replayed, false);
    assert.equal(runs, 1);

    const second = graph.runMutationOnce(operationId, mutate);
    assert.equal(second.replayed, true, 'the second request must be recognised as a replay');
    assert.equal(runs, 1, 'the mutation body must not run twice');
    assert.deepEqual(second.result, first.result);
  });

  test(`operationId ${JSON.stringify(operationId)} survives a journal round trip`, () => {
    const { graph, memoryPath } = makeGraph();
    graph.runMutationOnce(operationId, () => ({ ok: true }));

    const journalPath = graph._jsonJournalPath();
    const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.ok(
      Object.prototype.hasOwnProperty.call(persisted.operations, operationId),
      'the identifier must be persisted as an own property',
    );

    const reread = readMutationJournal(journalPath);
    assert.equal(Object.getPrototypeOf(reread.operations), null);
    assert.equal(reread.operations[operationId].status, 'completed');

    // A fresh Graph over the same files must still see the completed record.
    const reopened = new Graph({ noLoad: true, useSQLite: false, memoryPath });
    assert.equal(reopened.runMutationOnce(operationId, () => ({ ok: false })).replayed, true);
  });
}

test('an unknown prototype-special identifier reads back as absent, not as an inherited value', () => {
  const { graph } = makeGraph();
  for (const operationId of HOSTILE_IDS) {
    assert.equal(
      graph.getCommittedMutationResultByOperation(operationId),
      null,
      `${operationId} must not resolve to an inherited Object.prototype member`,
    );
  }
});

test('toJournalSection keeps own keys and drops the prototype', () => {
  const parsed = JSON.parse('{"__proto__": {"status": "completed"}, "normal": {"status": "completed"}}');
  const section = toJournalSection(parsed);
  assert.equal(Object.getPrototypeOf(section), null);
  assert.deepEqual(Object.keys(section).sort(), ['__proto__', 'normal']);
  assert.equal(section.__proto__.status, 'completed');
  assert.equal(({}).status, undefined, 'Object.prototype must be untouched');
});

test('ordinary replay behaviour is unchanged', () => {
  const { graph } = makeGraph();
  let runs = 0;
  const first = graph.runMutationOnce('op-normal', () => ({ runs: (runs += 1) }));
  const second = graph.runMutationOnce('op-normal', () => ({ runs: (runs += 1) }));
  const other = graph.runMutationOnce('op-other', () => ({ runs: (runs += 1) }));

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(other.replayed, false);
  assert.equal(runs, 2);
});
