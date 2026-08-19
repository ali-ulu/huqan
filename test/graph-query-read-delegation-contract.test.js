'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { query } = require('../lib/graph-query-read');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
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
  assert.equal(methodBody(graphSource, 'query'), 'return runGraphQuery(this._nodes, label, workspaceId);');
});

test('GRAPH: query delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /normalizeWorkspaceId/);
  assert.match(delegateSource, /cloneNodeRecord/);
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

  const results = query(nodes, 'animal', 'workspace-a');
  assert.deepEqual(results.map(node => node.id), ['cat']);
  results[0].tags.push('mutated');
  assert.deepEqual(nodes['workspace-a::cat'].tags, ['mammal']);

  assert.deepEqual(query(nodes, 'animal'), [nodes['default::dog']]);
  assert.deepEqual(query(nodes, 'missing'), []);
  assert.deepEqual(query(nodes, 'animal', ''), [nodes['default::dog']]);
});
