'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GRAPH_SOURCE = path.join(__dirname, '..', 'graph.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'graph-causal-chain.js');
const graphSource = fs.readFileSync(GRAPH_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('GRAPH: causal-chain traversal is delegated to its dedicated module', () => {
  assert.ok(
    graphSource.includes("const { getCausalChain: runCausalChain } = require('./lib/graph-causal-chain');"),
    'graph.js imports the causal-chain runner',
  );
  const methodMatch = graphSource.match(/\n  getCausalChain\(fromId, maxDepthOrOpts = 10\) \{[\s\S]*?\n  \}/);
  assert.ok(methodMatch, 'getCausalChain method still exists');
  const body = methodMatch[0];
  assert.match(
    body,
    /getCausalChain\(fromId, maxDepthOrOpts = 10\) \{\s*\n    return runCausalChain\(this, fromId, maxDepthOrOpts\);\s*\n  \}/,
    'getCausalChain is a one-line delegation',
  );

  const stripped = body.replace(/return runCausalChain\([\s\S]*?\);/, '');
  for (const banned of [
    'normalizeCausalStep',
    'attachTraversalMeta',
    'compareCausalEdges',
    'new Set',
    'queue.shift',
    'this._nodes',
    'this._edges',
    'this._db',
    'this._stmts',
  ]) {
    assert.ok(!stripped.includes(banned), `Graph wrapper must not contain ${banned}`);
  }
});

test('GRAPH: causal-chain delegate is receiver-free and cycle-free', () => {
  assert.equal((graphSource.match(/require\('\.\/lib\/graph-causal-chain'\)/g) || []).length, 1, 'delegate require appears once');
  assert.equal((graphSource.match(/runCausalChain\(/g) || []).length, 1, 'runner has one call site');
  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this receiver access');
  assert.ok(!delegateCode.includes("require('../graph')"), 'delegate has no cycle back into graph.js');
  assert.ok(!delegateCode.includes("require('./graph')"), 'delegate has no cycle through graph.js');
  for (const banned of [
    '_db',
    '_stmts',
    '_nodes',
    '_edges',
    'new Database',
    'fs.writeFile',
    'fs.rename',
    'save(',
    'load(',
  ]) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch Graph internals (${banned})`);
  }
  assert.match(delegateCode, /graph\.getNode\(fromId, workspaceId\)/, 'delegate reads nodes through Graph public API');
  assert.match(delegateCode, /graph\.getCausalEdges\(node, workspaceId\)/, 'delegate reads causal edges through Graph public API');
});
