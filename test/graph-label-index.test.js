'use strict';

// #3009: label lookups must not scan every node. The observable contract is
// unchanged -- query() returns the same clones for the same (label, workspace)
// and never leaks the internal storage key. These tests pin both the result and
// the index's invariant: it is derived from `_nodes` and always tracks it.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLabelIndex,
  indexNode,
  deindexNode,
  rebuildLabelIndex,
  queryLabelKeys,
  labelBucketKey,
} = require('../lib/graph-label-index');

test('GRAPH #3009: label index bucketed by workspace and label, no cross-workspace bleed', () => {
  const index = createLabelIndex();
  rebuildLabelIndex(index, {
    'default::dog': { id: 'dog', label: 'animal', workspaceId: 'default' },
    'team::cat': { id: 'cat', label: 'animal', workspaceId: 'team' },
    'team::table': { id: 'table', label: 'object', workspaceId: 'team' },
  });

  assert.deepEqual(queryLabelKeys(index, 'animal', 'default'), ['default::dog']);
  assert.deepEqual(queryLabelKeys(index, 'animal', 'team'), ['team::cat']);
  assert.deepEqual(queryLabelKeys(index, 'object', 'default'), []);
  assert.deepEqual(queryLabelKeys(index, 'missing', 'team'), []);

  // Blank/missing workspace falls back to 'default', matching normalizeWorkspaceId.
  assert.deepEqual(queryLabelKeys(index, 'animal', ''), ['default::dog']);
  assert.deepEqual(queryLabelKeys(index, 'animal'), ['default::dog']);
});

test('GRAPH #3009: reindexing a node moves it between buckets instead of duplicating', () => {
  const index = createLabelIndex();
  indexNode(index, 'k', { id: 'k', label: 'a', workspaceId: 'w' });
  assert.deepEqual(queryLabelKeys(index, 'a', 'w'), ['k']);

  indexNode(index, 'k', { id: 'k', label: 'b', workspaceId: 'w' });
  assert.deepEqual(queryLabelKeys(index, 'a', 'w'), []);
  assert.deepEqual(queryLabelKeys(index, 'b', 'w'), ['k']);

  indexNode(index, 'k', { id: 'k', label: 'b', workspaceId: 'other' });
  assert.deepEqual(queryLabelKeys(index, 'b', 'w'), []);
  assert.deepEqual(queryLabelKeys(index, 'b', 'other'), ['k']);

  assert.equal(deindexNode(index, 'k'), true);
  assert.equal(deindexNode(index, 'k'), false);
  assert.deepEqual(queryLabelKeys(index, 'b', 'other'), []);
});

test('GRAPH #3009: a label containing the bucket separator keys a distinct bucket', () => {
  const index = createLabelIndex();
  indexNode(index, 'k', { id: 'k', label: 'a\u0000b', workspaceId: 'w' });
  assert.deepEqual(queryLabelKeys(index, 'a\u0000b', 'w'), ['k']);
  assert.deepEqual(queryLabelKeys(index, 'a', 'w'), []);
  assert.notEqual(labelBucketKey('w', 'a\u0000b'), labelBucketKey('w\u0000a', 'b'));
});

test('GRAPH #3009: rebuild reflects deletions and additions from the node map', () => {
  const index = createLabelIndex();
  const nodes = {
    'default::one': { id: 'one', label: 'x', workspaceId: 'default' },
    'default::two': { id: 'two', label: 'x', workspaceId: 'default' },
  };
  rebuildLabelIndex(index, nodes);
  assert.deepEqual(queryLabelKeys(index, 'x', 'default').sort(), ['default::one', 'default::two']);

  delete nodes['default::one'];
  nodes['default::three'] = { id: 'three', label: 'y', workspaceId: 'default' };
  rebuildLabelIndex(index, nodes);
  assert.deepEqual(queryLabelKeys(index, 'x', 'default'), ['default::two']);
  assert.deepEqual(queryLabelKeys(index, 'y', 'default'), ['default::three']);
});
