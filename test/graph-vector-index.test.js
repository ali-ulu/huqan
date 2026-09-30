'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { createDreamContext, findGapHypotheses } = require('../lib/dream-hypothesis-finders');

test('Graph maintains sparse vector candidates across writes, delete and rebuild', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-vector-index-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  try {
    graph.addNode('gap', 'gap', null, { workspaceId: 'ws' });
    graph.addTag('gap', 'shared', 1, 'ws');
    graph.addNode('match', 'match', null, { workspaceId: 'ws' });
    graph.addTag('match', 'shared', 1, 'ws');
    graph.addNode('other', 'other', null, { workspaceId: 'ws' });
    graph.addTag('other', 'different', 1, 'ws');
    graph.addNode('foreign', 'foreign', null, { workspaceId: 'other' });
    graph.addTag('foreign', 'shared', 1, 'other');
    assert.deepEqual(new Set(graph.similarityCandidateIds({ shared: 1 }, 'ws')), new Set(['gap', 'match']));
    graph.removeNode('match', 'ws');
    assert.deepEqual(graph.similarityCandidateIds({ shared: 1 }, 'ws'), ['gap']);
    graph.rebuildIndex();
    assert.deepEqual(graph.similarityCandidateIds({ shared: 1 }, 'ws'), ['gap']);
  } finally {
    graph.close?.();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
});

test('Dream gap lookup compares only indexed shared-dimension candidates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-vector-dream-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  try {
    graph.addNode('gap', 'gap', null, { workspaceId: 'ws' });
    graph.addTag('gap', 'shared', 1, 'ws');
    for (let i = 0; i < 1000; i++) {
      graph.addNode(`other-${i}`, `other-${i}`, null, { workspaceId: 'ws' });
      graph.addTag(`other-${i}`, `tag-${i}`, 1, 'ws');
    }
    graph.addNode('match', 'match', null, { workspaceId: 'ws' });
    graph.addTag('match', 'shared', 1, 'ws');
    const nodes = Object.values(graph.getNodes('ws'));
    const context = createDreamContext(graph, nodes, 'ws');
    const original = graph.cosineSimilarity.bind(graph);
    let comparisons = 0;
    graph.cosineSimilarity = (...args) => { comparisons++; return original(...args); };
    const hypotheses = [];
    findGapHypotheses({ detectGaps: () => ['gap'] }, graph, nodes, hypotheses, context);
    assert.equal(comparisons, 1);
    assert.equal(hypotheses[0]?.to, 'match');
  } finally {
    graph.close?.();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
});

test('Removing an unsafe node resumes indexed candidate lookup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-vector-unsafe-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  try {
    graph.addNode('gap', 'gap', null, { workspaceId: 'ws' });
    graph.addTag('gap', 'shared', 1, 'ws');
    graph.addNode('match', 'match', null, { workspaceId: 'ws' });
    graph.addTag('match', 'shared', 1, 'ws');
    graph.addNode('bad', 'bad', null, { workspaceId: 'ws' });
    graph.addTag('bad', 'shared', Infinity, 'ws');
    assert.equal(graph.similarityCandidateIds({ shared: 1 }, 'ws'), null);
    graph.removeNode('bad', 'ws');
    assert.deepEqual(new Set(graph.similarityCandidateIds({ shared: 1 }, 'ws')),
      new Set(['gap', 'match']));
    // Two unsafe nodes keep the workspace unsafe until all are gone.
    graph.addNode('bad', 'bad', null, { workspaceId: 'ws' });
    graph.addTag('bad', 'shared', Infinity, 'ws');
    graph.addNode('bad2', 'bad2', null, { workspaceId: 'ws' });
    graph.addTag('bad2', 'shared', Infinity, 'ws');
    assert.equal(graph.similarityCandidateIds({ shared: 1 }, 'ws'), null);
    graph.removeNode('bad', 'ws');
    assert.equal(graph.similarityCandidateIds({ shared: 1 }, 'ws'), null);
    graph.removeNode('bad2', 'ws');
    assert.deepEqual(new Set(graph.similarityCandidateIds({ shared: 1 }, 'ws')),
      new Set(['gap', 'match']));
  } finally {
    graph.close?.();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
});

test('SQLite graph reload rebuilds vector candidates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-vector-reload-'));
  const options = { useSQLite: true, memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'graph.db') };
  const first = new Graph(options);
  try {
    first.addNode('gap', 'gap', null, { workspaceId: 'ws' });
    first.addTag('gap', 'shared', 1, 'ws');
    first.addNode('match', 'match', null, { workspaceId: 'ws' });
    first.addTag('match', 'shared', 1, 'ws');
    first.save();
  } finally {
    first.close();
  }
  const reopened = new Graph(options);
  try {
    reopened.load();
    assert.deepEqual(new Set(reopened.similarityCandidateIds({ shared: 1 }, 'ws')),
      new Set(['gap', 'match']));
  } finally {
    reopened.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
});
