'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { getStats } = require('../lib/graph-stats');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-stats.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: getStats is a one-line delegate', () => {
  assert.equal(methodBody(graphSource, 'getStats'), 'return runGraphStats(this._statsStoreApi());');
});

test('GRAPH: stats delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: stats delegate preserves counts, claims, decay, and JSON backend', () => {
  assert.deepEqual(getStats({
    nodeCount: () => 3,
    edgeCount: () => 4,
    candidateClaims: [{}, {}],
    decayLambda: 0.02,
    hasSqlite: false,
  }), {
    nodes: 3,
    edges: 4,
    candidateClaims: 2,
    decayLambda: 0.02,
    backend: 'json',
  });
});

test('GRAPH: stats delegate reports SQLite backend without changing counts', () => {
  assert.deepEqual(getStats({
    nodeCount: () => 1,
    edgeCount: () => 0,
    candidateClaims: [],
    decayLambda: 0,
    hasSqlite: true,
  }), {
    nodes: 1,
    edges: 0,
    candidateClaims: 0,
    decayLambda: 0,
    backend: 'sqlite',
  });
});
