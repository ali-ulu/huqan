'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { query } = require('../lib/graph-query-read');
const { createLabelIndex, rebuildLabelIndex } = require('../lib/graph-label-index');
const { readGraphSurfaceSource } = require('./helpers/graph-surface-source');

const graphSource = readGraphSurfaceSource();
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-query-read.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: query is a one-line delegate', () => {
  assert.equal(methodBody(graphSource, 'query'), 'return runGraphQuery(this._nodes, label, workspaceId, this._labelIndex, options);');
});

test('GRAPH: query delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /queryLabelKeys/);
  assert.match(delegateSource, /cloneNodeRecord/);
  assert.match(delegateSource, /function query\(nodes, label, workspaceId = 'default',/);
});

test('GRAPH: query delegate preserves label/workspace filtering and defensive cloning', () => {
  const nodes = {
    'default::dog': {
      id: 'dog',
      label: 'animal',
      workspaceId: 'default',
      tags: ['mammal'],
      vector: { fur: 0.8 },
      provenance: { source: 'fixture' },
    },
    'workspace-a::cat': {
      id: 'cat',
      label: 'animal',
      workspaceId: ' workspace-a ',
      tags: ['mammal'],
    },
    'workspace-a::table': {
      id: 'table',
      label: 'object',
      workspaceId: 'workspace-a',
    },
  };
  const index = createLabelIndex();
  rebuildLabelIndex(index, nodes);

  const results = query(nodes, 'animal', 'workspace-a', index);
  assert.deepEqual(results.map(node => node.id), ['cat']);
  results[0].tags.push('mutated');
  assert.deepEqual(nodes['workspace-a::cat'].tags, ['mammal']);

  assert.deepEqual(query(nodes, 'animal', 'default', index), [nodes['default::dog']]);
  assert.deepEqual(query(nodes, 'missing', 'default', index), []);
  assert.deepEqual(query(nodes, 'animal', '', index), [nodes['default::dog']]);
});

test('GRAPH: query delegate supports bounds/clone options (#3012)', () => {
  const nodes = {
    'default::a': { id: 'a', label: 'animal', workspaceId: 'default', tags: ['x'] },
    'default::b': { id: 'b', label: 'animal', workspaceId: 'default', tags: ['y'] },
    'default::c': { id: 'c', label: 'animal', workspaceId: 'default', tags: ['z'] },
  };
  const index = createLabelIndex();
  rebuildLabelIndex(index, nodes);

  // limit
  assert.equal(query(nodes, 'animal', 'default', index, { limit: 2 }).length, 2);
  // limit + offset
  assert.deepEqual(query(nodes, 'animal', 'default', index, { limit: 1, offset: 1 }).map(n => n.id), ['b']);
  // clone:false returns frozen view
  const frozen = query(nodes, 'animal', 'default', index, { limit: 1, clone: false })[0];
  assert.equal(Object.isFrozen(frozen), true);
  assert.throws(() => { frozen.id = 'mutated'; });
  // default still deep-clones
  const cloned = query(nodes, 'animal', 'default', index, { limit: 1 })[0];
  cloned.tags.push('mutated');
  assert.deepEqual(nodes['default::a'].tags, ['x']);
});