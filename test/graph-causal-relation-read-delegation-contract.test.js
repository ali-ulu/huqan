'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  isCausalRelation,
  getCausalRelations,
  getCausalEdges,
} = require('../lib/graph-causal-relation-read');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-causal-relation-read.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: causal relation helpers are one-line delegates', () => {
  assert.equal(methodBody(graphSource, 'isCausalRelation'), 'return runIsCausalRelation(CAUSAL_RELATIONS, relation);');
  assert.equal(methodBody(graphSource, 'getCausalRelations'), 'return runCausalRelations(CAUSAL_RELATIONS);');
  assert.equal(
    methodBody(graphSource, 'getCausalEdges'),
    'return runCausalEdges((id, scope) => this.getEdges(id, scope), CAUSAL_RELATIONS, compareCausalEdges, fromId, workspaceId);',
  );
});

test('GRAPH: causal relation delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: causal relation delegate preserves membership and defensive relation copies', () => {
  const relations = ['CAUSES', 'PREVENTS'];
  assert.equal(isCausalRelation(relations, 'CAUSES'), true);
  assert.equal(isCausalRelation(relations, 'SUPPORTS'), false);
  const copy = getCausalRelations(relations);
  assert.deepEqual(copy, relations);
  assert.notEqual(copy, relations);
  copy.push('ENABLES');
  assert.deepEqual(relations, ['CAUSES', 'PREVENTS']);
});

test('GRAPH: causal edge delegate preserves scoped lookup, filtering, and ordering', () => {
  const calls = [];
  const edges = [
    { relation: 'CAUSES', order: 3 },
    { relation: 'SUPPORTS', order: 1 },
    { relation: 'PREVENTS', order: 2 },
  ];
  const result = getCausalEdges(
    (fromId, workspaceId) => {
      calls.push([fromId, workspaceId]);
      return edges;
    },
    ['CAUSES', 'PREVENTS'],
    (a, b) => a.order - b.order,
    'source',
    'workspace-a',
  );

  assert.deepEqual(result, [edges[2], edges[0]]);
  assert.deepEqual(calls, [['source', 'workspace-a']]);
  assert.notEqual(result, edges);
});
