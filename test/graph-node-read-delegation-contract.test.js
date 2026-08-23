'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegatePath = path.join(__dirname, '..', 'lib', 'graph-node-read.js');
const delegateSource = fs.readFileSync(delegatePath, 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: node reads are delegated to the dedicated module', () => {
  assert.equal(
    methodBody(graphSource, 'getNodes'),
    'return runNodesRead(this._nodes, workspaceId);',
  );
  assert.equal(
    methodBody(graphSource, 'getNode'),
    'return runNodeRead(this._nodes, id, workspaceId);',
  );
});

test('GRAPH: node-read delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.match(delegateSource, /function getNodes\(nodes, workspaceId = 'default'\)/);
  assert.match(delegateSource, /function getNode\(nodes, id, workspaceId = 'default'\)/);
});

test('GRAPH: node-read delegate preserves workspace isolation and cloned results', () => {
  const { getNode, getNodes } = require('../lib/graph-node-read');
  const nodes = {
    alpha: { id: 'alpha', workspaceId: 'default', tags: ['one'], vector: { x: 1 } },
    'team::alpha': { id: 'alpha', workspaceId: 'team', tags: ['two'], vector: { y: 2 } },
  };

  const defaultNodes = getNodes(nodes, 'default');
  assert.deepEqual(Object.keys(defaultNodes), ['alpha']);
  assert.notEqual(defaultNodes.alpha, nodes.alpha);
  defaultNodes.alpha.tags.push('mutated');
  assert.deepEqual(nodes.alpha.tags, ['one']);

  assert.equal(getNode(nodes, 'alpha', 'missing'), null);
  assert.equal(getNode(nodes, 'alpha', 'team').workspaceId, 'team');
  assert.equal(getNode(nodes, 'alpha', 'default').workspaceId, 'default');
});

test('GRAPH: node-read delegate keys getNodes by node id, not the internal storage key, in every workspace (#1294)', () => {
  const { getNodes } = require('../lib/graph-node-read');
  const nodes = {
    alpha: { id: 'alpha', workspaceId: 'default' },
    'team::alpha': { id: 'alpha', workspaceId: 'team' },
    'team::beta': { id: 'beta', workspaceId: 'team' },
  };

  const defaultNodes = getNodes(nodes, 'default');
  assert.deepEqual(Object.keys(defaultNodes).sort(), ['alpha']);

  // Before the fix this returned {'team::alpha': ..., 'team::beta': ...} --
  // the raw storage key, scope-prefixed for every workspace but 'default' --
  // which broke any consumer treating Object.keys(getNodes(...)) as node
  // ids (e.g. extractFacts's multi-word subject match).
  const teamNodes = getNodes(nodes, 'team');
  assert.deepEqual(Object.keys(teamNodes).sort(), ['alpha', 'beta']);
  assert.equal(teamNodes.alpha.workspaceId, 'team');
  assert.equal(teamNodes.beta.workspaceId, 'team');
});
