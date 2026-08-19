'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { getWeight } = require('../lib/graph-node-weight');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-node-weight.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: getWeight is a one-line delegate', () => {
  assert.equal(
    methodBody(graphSource, 'getWeight'),
    'return runNodeWeight((nodeId, scope) => this.getNode(nodeId, scope), this._decayLambda, id, workspaceId);',
  );
});

test('GRAPH: node-weight delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: node-weight delegate preserves scoped lookup, decay, and clamping', () => {
  const calls = [];
  const node = { lastAccessed: Date.now() - 1000, weight: 2 };
  const result = getWeight((id, workspaceId) => {
    calls.push([id, workspaceId]);
    return node;
  }, 0.1, 'alpha', 'workspace-a');

  assert.ok(result > 0.8 && result <= 1);
  assert.deepEqual(calls, [['alpha', 'workspace-a']]);
});

test('GRAPH: node-weight delegate returns zero for a missing node', () => {
  assert.equal(getWeight(() => null, 0.05, 'missing', 'workspace-a'), 0);
});
