'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Kernel = require('../kernel');
const createCompanyBrainPlugin = require('../plugins/company-brain').create;

// #2160: company-brain's manual ingest reached the Kernel's private
// `_parsePredicate`. The public `parsePredicate` already exists on Kernel
// (and KernelV2 forwards it), so the plugin uses that instead -- the same
// boundary #2441 drew for contradiction-alert.

const PLUGIN_SOURCES = [
  'company-brain.js',
  'company-brain-state.js',
  'company-brain-query.js',
  'company-brain-ingest.js',
].map((name) => path.join(__dirname, '..', 'plugins', name));

test('company-brain uses the public predicate parser boundary', () => {
  const sources = PLUGIN_SOURCES.map((file) => fs.readFileSync(file, 'utf8'));
  // The entry file plus its ./company-brain-* require chain: moved code must
  // not escape the forbidden-pattern check (#2120 split).
  assert.match(sources.join('\n'), /kernel\.parsePredicate\(fact\.predicate\)/);
  for (const source of sources) {
    assert.doesNotMatch(source, /kernel\._parsePredicate/);
  }
});

test('manual ingest turns an extracted fact into an edge through the public parser only', async () => {
  const realKernel = new Kernel({ noLoad: true, loadPlugins: false, useSQLite: false });
  const proposed = [];
  const kernel = {
    graph: { getNodes: () => ({ kedi: { label: 'kedi' } }), getEdges: () => [], getInEdges: () => [] },
    extractFacts: () => [{ subject: 'kedi', predicate: 'hayvandir' }],
    parsePredicate: (predicate) => realKernel.parsePredicate(predicate),
    _parsePredicate() { throw new Error('private Kernel#_parsePredicate used'); },
    hasCapability: () => false,
    proposeNode: () => {},
    proposeEdge: (from, to, relation) => { proposed.push({ from, to, relation }); return { edge: { from, to, relation } }; },
  };

  const result = await createCompanyBrainPlugin().run(kernel, {
    action: 'manual', sourceType: 'manual', text: 'kedi hayvandir', author: 'test', date: '2026-09-14',
  }, { capability: { name: 'companyBrain' } });

  assert.equal(result.ok, true);
  const factEdge = proposed.find(edge => edge.from === 'kedi' && edge.to !== undefined && edge.relation !== 'mentions');
  assert.ok(factEdge, `the fact must become an edge: ${JSON.stringify(proposed)}`);
  assert.deepEqual(realKernel.parsePredicate('hayvandir'), realKernel._parsePredicate('hayvandir'),
    'the public parser is the one the private alias forwards to');
});
