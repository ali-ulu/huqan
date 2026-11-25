'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const Graph = require('../graph');
const { readMutationJournal } = require('../lib/mutation-journal');

function makeGraph() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-journal-cache-'));
  const graph = new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false, noLoad: true });
  return { graph, root };
}

function countJournalReads(graph, run) {
  const journalPath = graph.jsonJournalPath();
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(file, ...rest) {
    if (String(file) === journalPath) reads += 1;
    return original.call(this, file, ...rest);
  };
  try { run(); }
  finally { fs.readFileSync = original; }
  return reads;
}

test('a session does not re-parse the journal it already parsed', () => {
  const { graph, root } = makeGraph();
  const commits = 4;
  const reads = countJournalReads(graph, () => {
    for (let i = 0; i < commits; i += 1) {
      graph.runMutationOnce(`op-${i}`, () => { graph.addNode(`n${i}`, `N ${i}`); return { ok: true }; });
    }
  });

  // One parse at the start plus the publish-time verification of each commit.
  assert.ok(reads <= commits + 1, `expected at most ${commits + 1} journal reads, saw ${reads}`);
  assert.equal(Object.keys(readMutationJournal(graph.jsonJournalPath()).operations).length, commits);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a journal written by somebody else is not missed by the cached parse', () => {
  const { graph, root } = makeGraph();
  graph.runMutationOnce('op-own', () => { graph.addNode('mine', 'Mine'); return { ok: true }; });

  const journalPath = graph.jsonJournalPath();
  const foreign = readMutationJournal(journalPath);
  foreign.operations['op-foreign'] = { status: 'completed', result: { ok: true, foreign: true }, receiptId: null, committedAt: new Date().toISOString() };
  fs.writeFileSync(journalPath, JSON.stringify(foreign));

  const replayed = graph.runMutationOnce('op-foreign', () => {
    throw new Error('the foreign operation must replay, not run again');
  });

  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.result, { ok: true, foreign: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('a commit that died before its record leaves nothing for the cache to believe', () => {
  const { graph, root } = makeGraph();
  graph.runMutationOnce('op-seed', () => { graph.addNode('a', 'A'); return { ok: true }; });

  graph._jsonTransactionFault = (point) => { if (point === 'before-prepared') throw new Error('process died'); };
  assert.throws(() => graph.runMutationOnce('op-dies', () => { graph.addNode('b', 'B'); return { ok: true }; }), /process died/);
  graph._jsonTransactionFault = null;

  assert.equal(readMutationJournal(graph.jsonJournalPath()).operations['op-dies'], undefined);
  const retried = graph.runMutationOnce('op-dies', () => { graph.addNode('b', 'B'); return { ok: true }; });
  assert.equal(retried.replayed, false);
  assert.equal(graph.getNode('b').id, 'b');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a commit that died after its record is replayed from the recovered journal', () => {
  const { graph, root } = makeGraph();
  graph.runMutationOnce('op-seed', () => { graph.addNode('a', 'A'); return { ok: true }; });

  graph._jsonTransactionFault = (point) => { if (point === 'after-prepared') throw new Error('process died'); };
  assert.throws(() => graph.runMutationOnce('op-dies', () => { graph.addNode('b', 'B'); return { ok: true }; }), /process died/);
  graph._jsonTransactionFault = null;

  // Recovery publishes the pending record, so the retry must not run the body a second time.
  const retried = graph.runMutationOnce('op-dies', () => { throw new Error('the recovered operation must not run again'); });
  assert.equal(retried.replayed, true);
  assert.equal(graph.getNode('b').id, 'b');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a store rewritten with identical bytes is not a conflict', () => {
  const { graph, root } = makeGraph();
  graph.runMutationOnce('op-first', () => { graph.addNode('a', 'A'); return { ok: true }; });

  const memoryPath = graph.memoryPath;
  const bytes = fs.readFileSync(memoryPath);
  fs.writeFileSync(`${memoryPath}.copy`, bytes);
  fs.renameSync(`${memoryPath}.copy`, memoryPath);

  const next = graph.runMutationOnce('op-second', () => { graph.addNode('b', 'B'); return { ok: true }; });
  assert.equal(next.replayed, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a store rewritten with different bytes is reloaded while this process is clean', () => {
  const { graph, root } = makeGraph();
  graph.runMutationOnce('op-first', () => { graph.addNode('a', 'A'); return { ok: true }; });

  const memoryPath = graph.memoryPath;
  const state = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  state.nodes.outsider = { id: 'outsider', label: 'Outsider', type: 'node', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(memoryPath, JSON.stringify(state));

  graph.runMutationOnce('op-second', () => { graph.addNode('b', 'B'); return { ok: true }; });
  assert.equal(graph.getNode('outsider').id, 'outsider');
  assert.equal(graph.getNode('b').id, 'b');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a store rewritten with different bytes is a conflict when this process also moved', () => {
  const { graph, root } = makeGraph();
  graph.runMutationOnce('op-first', () => { graph.addNode('a', 'A'); return { ok: true }; });

  const memoryPath = graph.memoryPath;
  const state = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  state.nodes.outsider = { id: 'outsider', label: 'Outsider', type: 'node', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(memoryPath, JSON.stringify(state));
  graph.addNode('local-only', 'Local only');

  assert.throws(
    () => graph.runMutationOnce('op-second', () => { graph.addNode('b', 'B'); return { ok: true }; }),
    error => error.code === 'GRAPH_JSON_WRITE_CONFLICT',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('a caller mutating the returned result cannot change the committed journal', () => {
  const { graph, root } = makeGraph();
  const first = graph.runMutationOnce('op-a', () => ({ ok: true, data: { n: 1 } }));
  first.result.data.n = 99;
  graph.runMutationOnce('op-b', () => ({ ok: true }));

  assert.equal(readMutationJournal(graph.jsonJournalPath()).operations['op-a'].result.data.n, 1);
  const replayed = graph.runMutationOnce('op-a', () => { throw new Error('this operation must replay'); });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.result.data.n, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a snapshot records the file identity before it reads the bytes', () => {
  const { graph, root } = makeGraph();
  graph.runMutationOnce('op-a', () => { graph.addNode('a', 'A'); return { ok: true }; });

  const events = [];
  const { statSync, readFileSync } = fs;
  fs.statSync = function patched(file, ...rest) {
    if (String(file) === graph.memoryPath) events.push('stat');
    return statSync.call(this, file, ...rest);
  };
  fs.readFileSync = function patched(file, ...rest) {
    if (String(file) === graph.memoryPath) events.push('read');
    return readFileSync.call(this, file, ...rest);
  };
  try { graph.load(); }
  finally { fs.statSync = statSync; fs.readFileSync = readFileSync; }

  assert.ok(events.includes('stat') && events.indexOf('stat') < events.indexOf('read'),
    `expected the stat before the read, saw ${events.join(',')}`);
  fs.rmSync(root, { recursive: true, force: true });
});
