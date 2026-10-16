'use strict';

/**
 * Three company-brain failures that shared one shape: a value that must
 * distinguish whole inputs was derived from a truncated or mis-folded piece
 * of them.
 *
 *  - query matching tokenized with plain `.toLowerCase()`, so `İ` (U+0130)
 *    became `i` + U+0307 and the combining dot split the word. "İADE"
 *    tokenized to "ade", which substring-matched the unrelated node "kademe"
 *    and returned it as graph evidence.
 *  - `ingestManual` counted only the fact edge, so a note that wrote two
 *    edges reported `added: 1` and dragged `distribution.manual` low.
 *  - the no-predicate fallback and the API path keyed their target node on
 *    `text.slice(0, 96)`, so two notes diverging after character 96 collapsed
 *    onto one node, silently, both returning ok:true.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const companyBrain = require('../plugins/company-brain');
const createCompanyBrainPlugin = companyBrain.create;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-company-brain-harden-'));

test.after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

let seq = 0;
function makeKernel() {
  seq += 1;
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `k${seq}.json`),
    capabilities: { companyMode: true, pluginCapabilities: true, evidenceRanking: true },
  });
  kernel.usePlugin(createCompanyBrainPlugin());
  return kernel;
}

test('a Turkish İ query matches its plain-i node instead of a fragment of another', async () => {
  const kernel = makeKernel();
  for (const [id, label] of [
    ['urun-iade-politikasi', 'ÜRÜN İADE POLİTİKASI'],
    ['musteri-memnuniyeti', 'Müşteri Memnuniyeti'],
    ['kademe-planlama', 'Kademe Planlama'],
    ['butce', 'Bütçe'],
  ]) kernel.graph.addNode(id, label);
  kernel.graph.addEdge('urun-iade-politikasi', 'musteri-memnuniyeti', 'is_a', { weight: 1, confidence: 0.8 });
  kernel.graph.addEdge('kademe-planlama', 'butce', 'is_a', { weight: 1, confidence: 0.8 });

  const result = await kernel.runCapability('companyBrain', { action: 'query', question: 'İADE politikası nedir' });

  assert.equal(result.mode, 'graph', 'the İADE node must be reachable from an İ-spelled query');
  const froms = result.evidence.map((edge) => edge.from);
  assert.ok(froms.includes('urun-iade-politikasi'), `expected the İADE node, got ${JSON.stringify(froms)}`);
  assert.ok(!froms.includes('kademe-planlama'), 'the "ade" fragment must not match "kademe"');
});

test('I, İ and ı spellings of one word produce the same query token', () => {
  // Same fold `identityKey`/`slug` use; asserted through observable matches
  // rather than by exporting the private tokenizer.
  const kernel = makeKernel();
  kernel.graph.addNode('iade-politikasi', 'IADE POLITIKASI');
  kernel.graph.addNode('musteri', 'Musteri');
  kernel.graph.addEdge('iade-politikasi', 'musteri', 'is_a', { weight: 1, confidence: 0.8 });

  return Promise.all(['IADE', 'İADE', 'ıade'].map(async (word) => {
    const result = await kernel.runCapability('companyBrain', { action: 'query', question: `${word} nedir` });
    assert.equal(result.mode, 'graph', `${word} did not reach the node`);
    assert.ok(result.evidence.some((edge) => edge.from === 'iade-politikasi'), `${word} missed the node`);
  }));
});

test('ingestManual counts every edge it writes and the status distribution agrees', () => {
  const nodes = new Set();
  const edges = [];
  const kernel = {
    hasCapability: () => true,
    proposeNode: (id) => { nodes.add(id); return { decision: 'allow', node: { id } }; },
    proposeEdge: (from, to, relation) => {
      edges.push({ from, to, relation });
      return { decision: 'allow', edge: { from, to, relation } };
    },
    graph: { getStats: () => ({ nodes: nodes.size, edges: edges.length }) },
    extractFacts: () => ([{ subject: 'butce', predicate: 'is_a plan' }]),
    parsePredicate: () => ({ relation: 'is_a', object: 'plan' }),
  };

  const result = companyBrain._test.ingestManual(kernel, { text: 'Butce plani onaylandi', author: 'ali', date: '2026-08-23' });

  assert.equal(result.added, 2, 'the fact edge and the support edge must both count');
  assert.equal(companyBrain._test.getIngestStatus(kernel).distribution.manual, result.added);
});

// The predicate parser extracts nothing from these, which is what routes the
// note through the no-predicate fallback. Plain ASCII keeps the fixture's
// length predictable.
const UNPARSED_SHARED = 'Quarterly deployment runbook revision three covering the rollback procedure in detail and the escalation contacts for';
const UNPARSED_A = `${UNPARSED_SHARED} ALFA sequence`;
const UNPARSED_B = `${UNPARSED_SHARED} BETA sequence`;
const UNPARSED_SINGLE = 'Bilmem';

test('two notes diverging after the 96th character keep separate fallback nodes', async () => {
  const kernel = makeKernel();
  assert.ok(UNPARSED_SHARED.length >= 96, 'the fixture must agree past the old 96-character cut');
  assert.equal(kernel.extractFacts(UNPARSED_A, {}).length, 0, 'the fixture must reach the fallback');

  await kernel.runCapability('companyBrain', { action: 'manual', text: UNPARSED_A, author: 'x', date: '2026-01-01' });
  await kernel.runCapability('companyBrain', { action: 'manual', text: UNPARSED_B, author: 'x', date: '2026-01-01' });

  const all = Object.keys(kernel.graph.getNodes('default'));
  const fallbackTargets = all.filter((id) => id.startsWith('note:'));
  assert.equal(fallbackTargets.length, 2, `the two notes collapsed onto one node: ${JSON.stringify(all)}`);
  const rawLeaked = all.filter((id) => id.startsWith('Quarterly deployment'));
  assert.deepEqual(rawLeaked, [], 'raw note text must not become a node id');
});

test('the same note ingested twice still produces one fallback node', async () => {
  const kernel = makeKernel();
  assert.equal(kernel.extractFacts(UNPARSED_SINGLE, {}).length, 0, 'the fixture must reach the fallback');

  await kernel.runCapability('companyBrain', { action: 'manual', text: UNPARSED_SINGLE, author: 'x', date: '2026-01-01' });
  await kernel.runCapability('companyBrain', { action: 'manual', text: UNPARSED_SINGLE, author: 'x', date: '2026-01-01' });

  const fallbackTargets = Object.keys(kernel.graph.getNodes('default')).filter((id) => id.startsWith('note:'));
  assert.equal(fallbackTargets.length, 1, 'identity must stay stable for identical input');
});

test('the API fallback target keys on the whole text, not its first 96 characters', async () => {
  const kernel = makeKernel();
  assert.ok(UNPARSED_SHARED.length >= 96, 'the fixture must agree past the old 96-character cut');

  const first = await kernel.runCapability('companyBrain', { action: 'api', sourceRef: 'wiki:a', text: UNPARSED_A });
  const second = await kernel.runCapability('companyBrain', { action: 'api', sourceRef: 'wiki:b', text: UNPARSED_B });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const apiTargets = Object.keys(kernel.graph.getNodes('default')).filter((id) => id.startsWith('api-note:'));
  assert.equal(apiTargets.length, 4, 'two note nodes and two distinct fallback targets');
  const leaked = Object.keys(kernel.graph.getNodes('default')).filter((id) => id.startsWith('Quarterly deployment'));
  assert.deepEqual(leaked, [], 'raw API text must not become a node id');
});
