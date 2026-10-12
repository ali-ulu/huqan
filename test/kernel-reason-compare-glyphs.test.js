'use strict';

// #3641: lib/kernel-read-use-cases-analysis.js was once saved in a non-UTF-8
// encoding and its display glyphs became '?'. Pin the exact text a user sees so
// a re-encoding of the file turns red instead of shipping '??' to the CLI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');

const WS = 'workspace-glyphs';

function kernelWithCycle(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-glyphs-'));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
  t.after(() => {
    kernel.graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['a', 'b', 'c']) kernel.graph.addNode(id, id, null, { workspaceId: WS });
  kernel.graph.addEdge('a', 'b', 'causes', { weight: 0.9, workspaceId: WS });
  kernel.graph.addEdge('b', 'a', 'causes', { weight: 0.9, workspaceId: WS });
  kernel.graph.addEdge('b', 'c', 'is_a', { weight: 0.9, workspaceId: WS });
  return kernel;
}

test('reason marks a cycle with a warning sign and arrows', (t) => {
  const answer = kernelWithCycle(t).reason('a', WS).data.answer;
  assert.equal(answer, [
    'a:',
    '  üst tür: c [is_a]',
    '  neden olur: b [causes]',
    '  nedeni: b [causes]',
    '  ⚠ döngü tespit edildi: a → b → a',
  ].join('\n'));
});

test('compare opens with a chart banner and joins the connecting path with arrows', (t) => {
  const answer = kernelWithCycle(t).compare('a', 'c', WS).data.answer;
  assert.equal(answer, [
    '\u{1F4CA} a vs c:',
    '  sadece a: b [causes]',
    '  bağlantı: a → b → c',
  ].join('\n'));
  assert.doesNotMatch(answer, /\?|�/, 'no glyph was replaced by a placeholder');
});

// A directed graph is not undirected: two children of one parent share an edge
// target but form no cycle. Cycle detection used to walk in-edges as if they
// were out-edges, so `reason()` printed a fabricated loop and a bogus
// "ilk neden" for the commonest taxonomy shape there is.
test('reason does not invent a cycle from two nodes sharing a parent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-acyclic-'));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
  t.after(() => {
    kernel.graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['kedi', 'kopek', 'hayvan']) kernel.graph.addNode(id, id, null, { workspaceId: WS });
  kernel.graph.addEdge('kedi', 'hayvan', 'tür', { weight: 0.5, workspaceId: WS });
  kernel.graph.addEdge('kopek', 'hayvan', 'tür', { weight: 0.5, workspaceId: WS });

  const result = kernel.reason('kedi', WS).data;
  assert.deepEqual(result.cycles, [], 'a shared parent is not a cycle');
  assert.doesNotMatch(result.answer, /döngü/, 'no fabricated loop in the answer');
  assert.doesNotMatch(result.answer, /ilk neden/, 'no bogus root cause');
  assert.equal(result.answer, ['kedi:', '  üst tür: hayvan [tür]'].join('\n'));
});

// "tür"/"is_a" is taxonomy, not causation. reason() printed `kedi --tür--> hayvan`
// under "neden olur", which reads as "hayvan causes kedi" -- backwards and false.
// The causal family and the taxonomic family must stay in separate buckets.
test('reason does not present an is-a edge as a cause', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-isa-'));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
  t.after(() => {
    kernel.graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['kedi', 'hayvan', 'canli', 'sigara', 'kanser']) kernel.graph.addNode(id, id, null, { workspaceId: WS });
  kernel.graph.addEdge('kedi', 'hayvan', 'tür', { weight: 0.5, workspaceId: WS });
  kernel.graph.addEdge('hayvan', 'canli', 'tür', { weight: 0.5, workspaceId: WS });
  kernel.graph.addEdge('sigara', 'kanser', 'CAUSES', { weight: 0.9, strength: 0.9, workspaceId: WS });

  const answer = kernel.reason('kedi', WS).data.answer;
  assert.equal(answer, ['kedi:', '  üst tür: hayvan [tür], canli [tür]'].join('\n'));
  assert.doesNotMatch(answer, /neden olur/, 'a taxonomy edge is not a cause');

  const causal = kernel.reason('sigara', WS).data.answer;
  assert.equal(causal, ['sigara:', '  neden olur: kanser [CAUSES]'].join('\n'));
  assert.doesNotMatch(causal, /üst tür/, 'a CAUSES edge is not taxonomy');
});
