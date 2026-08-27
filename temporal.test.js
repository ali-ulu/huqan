const { isolatedKernelOptions, isolatedGraphOptions } = require('./test/helpers/isolated-persistence');
﻿const test = require('node:test');
const assert = require('node:assert/strict');
const Graph = require('./graph');

function isIso8601(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

test('temporal: addNode writes created_at and updates last_seen on update', async () => {
  const g = new Graph(isolatedGraphOptions('temporal', { useSQLite: false }));
  g.addNode('n1', 'node');
  const first = g.getNode('n1');
  const firstCreatedAt = first.created_at;
  const firstLastSeen = first.last_seen;

  assert.equal(isIso8601(firstCreatedAt), true);
  assert.equal(isIso8601(firstLastSeen), true);

  await new Promise(resolve => setTimeout(resolve, 5));
  g.addNode('n1', 'node-v2');
  const second = g.getNode('n1');

  assert.equal(second.created_at, firstCreatedAt);
  assert.equal(isIso8601(second.last_seen), true);
  assert.notEqual(second.last_seen, firstLastSeen);
});

test('temporal: addEdge writes ISO fields and confidence history', async () => {
  const g = new Graph(isolatedGraphOptions('temporal', { useSQLite: false }));
  g.addNode('a', 'A');
  g.addNode('b', 'B');

  g.addEdge('a', 'b', 'tur', {
    confidence: 0.5,
    source: 'manual',
    sourceRef: 'spec:test',
    sessionId: 's-1',
  });

  const first = g.getEdge('a', 'b', 'tur');
  assert.equal(isIso8601(first.created_at), true);
  assert.equal(isIso8601(first.updated_at), true);
  assert.equal(first.source_ref, 'spec:test');
  assert.equal(first.session_id, 's-1');
  assert.deepEqual(first.confidence_history, []);

  await new Promise(resolve => setTimeout(resolve, 5));
  g.addEdge('a', 'b', 'tur', {
    confidence: 0.9,
    sourceRef: 'spec:test-2',
    sessionId: 's-2',
  });

  const second = g.getEdge('a', 'b', 'tur');
  assert.equal(isIso8601(second.updated_at), true);
  assert.equal(second.source_ref, 'spec:test-2');
  assert.equal(second.session_id, 's-2');
  assert.equal(Array.isArray(second.confidence_history), true);
  assert.equal(second.confidence_history.length, 1);
  assert.equal(second.confidence_history[0].value, 0.5);
  assert.equal(isIso8601(second.confidence_history[0].updated_at), true);
});
