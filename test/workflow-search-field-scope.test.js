'use strict';

/**
 * Memory search must match what a node is called, not how it is stored.
 *
 * The filter ran over `JSON.stringify(node)`, so the query also hit field
 * names, timestamps, workspaceId, numeric weights and JSON punctuation:
 * `default`, `provenance`, `created`, `2026` and even `{` matched every node in
 * the workspace, and nothing in the returned records showed where the match
 * came from.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { searchMemory } = require('../lib/http/read-workflow-actions');

function node(id, overrides = {}) {
  return {
    id,
    label: `${id} claim`,
    tags: [],
    vector: {},
    weight: 0.5,
    workspaceId: 'default',
    created: 1787463097365,
    created_at: '2026-08-23T05:31:37.365Z',
    provenance: null,
    ...overrides,
  };
}

function graphOf(nodes) {
  return { getNodes: () => nodes };
}

const THREE = graphOf({
  kedi: node('kedi'),
  kopek: node('kopek'),
  kus: node('kus'),
});

test('a query only matches labels, ids and tags', () => {
  const result = searchMemory(THREE, { workspaceId: 'default', query: 'kedi' });

  assert.deepEqual(result.items.map((item) => item.id), ['kedi']);
});

test('storage-shape queries no longer match every node', () => {
  // Each of these matched all three nodes before: a field value, a numeric
  // weight, a field name, a timestamp fragment and JSON punctuation.
  for (const query of ['default', '0.', 'provenance', '2026', '{', 'created', 'vector']) {
    const result = searchMemory(THREE, { workspaceId: 'default', query });

    assert.deepEqual(result.items, [], `"${query}" must not match on serialization`);
  }
});

test('tags are searchable', () => {
  const graph = graphOf({ alpha: node('alpha', { tags: ['retention-policy'] }), beta: node('beta') });

  const result = searchMemory(graph, { workspaceId: 'default', query: 'retention' });

  assert.deepEqual(result.items.map((item) => item.id), ['alpha']);
});

test('a trimmed result says so, and an untrimmed one does not', () => {
  const many = {};
  for (let i = 0; i < 120; i += 1) many[`kedi-${i}`] = node(`kedi-${i}`);

  const trimmed = searchMemory(graphOf(many), { workspaceId: 'default', query: 'kedi' });
  assert.equal(trimmed.items.length, 50);
  assert.equal(trimmed.truncated, true);

  const whole = searchMemory(THREE, { workspaceId: 'default', query: 'kedi' });
  assert.equal(whole.truncated, false);
});

test('the scan stops inspecting nodes once the cap is passed', () => {
  // Every node in the workspace used to be JSON-serialized, because the slice
  // came after the filter. Counting reads of `label` counts the nodes actually
  // inspected.
  let inspected = 0;
  const nodes = {};
  for (let i = 0; i < 5000; i += 1) {
    const record = node(`kedi-${i}`);
    Object.defineProperty(record, 'label', {
      enumerable: true,
      get() { inspected += 1; return `kedi-${i} claim`; },
    });
    nodes[`kedi-${i}`] = record;
  }

  searchMemory({ getNodes: () => nodes }, { workspaceId: 'default', query: 'kedi' });

  // 51 during the scan (the cap plus the one that proves trimming) and 50 more
  // while projecting the kept rows. The point is that it is bounded by the cap
  // rather than by the size of the workspace.
  assert.ok(inspected < 150, `expected the scan to stop near the cap, inspected ${inspected} of 5000 nodes`);
});

test('an empty query or workspace still returns null', () => {
  assert.equal(searchMemory(THREE, { workspaceId: 'default', query: '' }), null);
  assert.equal(searchMemory(THREE, { workspaceId: '', query: 'kedi' }), null);
});
