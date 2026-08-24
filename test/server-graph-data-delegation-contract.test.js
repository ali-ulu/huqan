const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildGraphData } = require('../lib/server-graph-data');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server-graph-data.js'), 'utf8').replace(/\r\n/g, '\n');

test('server getGraphData is a one-line, cycle-free delegation', () => {
  assert.match(
    serverSource,
    /function getGraphData\(workspaceId = 'default'\) \{\n  return buildGraphData\(\{ graph: kernel\.graph, memory: kernel\.memory, getSafeMemoryLabel, workspaceId \}\);\n\}/,
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*(?:server|kernel)/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.deepEqual(Object.keys(require('../lib/server-graph-data')), ['buildGraphData']);
});

test('graph-data delegate preserves bounded graph and memory projections', () => {
  const graphCalls = [];
  const memoryCalls = [];
  const graph = {
    getNodes: workspaceId => {
      graphCalls.push(['getNodes', workspaceId]);
      return {
        high: { id: 'high', label: 'High', weight: 2, workspaceId },
        low: { id: 'low', label: 'Low', weight: 1, workspaceId },
      };
    },
    getAllEdges: workspaceId => {
      graphCalls.push(['getAllEdges', workspaceId]);
      return [{
        from: 'high',
        to: 'low',
        relation: 'supports',
        weight: 0.9,
        confidence: 0.91,
        source: 'fixture',
        evidence: ['one', 'two', 'three'],
        workspaceId,
      }];
    },
    getEdges: (nodeId, workspaceId) => {
      graphCalls.push(['getEdges', nodeId, workspaceId]);
      return nodeId === 'high' ? [{ id: 'edge' }] : [];
    },
  };
  const memory = {
    list: options => {
      memoryCalls.push(['list', options]);
      return { ok: true, memories: [{ memoryId: 'm1', content: 'secret', metadata: { weight: 0.7, tags: ['a', 'b'] }, workspaceId: options.workspaceId }] };
    },
    queryLinks: options => {
      memoryCalls.push(['queryLinks', options]);
      return { ok: true, links: [{ fromMemoryId: 'm1', toMemoryId: 'missing', relation: 'related', workspaceId: options.workspaceId }] };
    },
  };

  const result = buildGraphData({
    graph,
    memory,
    getSafeMemoryLabel: content => `safe:${content}`,
    workspaceId: 'tenant-a',
  });

  assert.deepEqual(result.nodes, [
    {
      id: 'high', label: 'High', weight: 2, edgeCount: 1, confidence: 0.91,
      sources: ['fixture'], evidenceCount: 3, workspaceId: 'tenant-a', last_seen: '', created_at: '',
    },
    {
      id: 'low', label: 'Low', weight: 1, edgeCount: 0, confidence: 0.91,
      sources: ['fixture'], evidenceCount: 3, workspaceId: 'tenant-a', last_seen: '', created_at: '',
    },
  ]);
  assert.deepEqual(result.links, [{
    source: 'high', target: 'low', relation: 'supports', weight: 0.9, confidence: 0.91,
    sourceType: '', evidenceSource: 'fixture', sourceRef: '', evidenceCount: 3,
    evidence: ['one', 'two'], updatedAt: '', createdAt: '', sessionId: '', workspaceId: 'tenant-a',
  }]);
  assert.deepEqual(result.memoryNodes, [{
    id: 'm1', label: 'safe:secret', type: 'memory', workspaceId: 'tenant-a', status: 'active', weight: 0.7,
    metadata: { weight: 0.7, tags: ['a', 'b'] },
  }]);
  assert.deepEqual(result.memoryLinks, []);
  assert.deepEqual(result.metadata, { memory: { enabled: true, nodeCount: 1, linkCount: 0, source: 'kernel.memory' } });
  assert.deepEqual(graphCalls, [
    ['getNodes', 'tenant-a'],
    ['getAllEdges', 'tenant-a'],
    ['getEdges', 'high', 'tenant-a'],
    ['getEdges', 'low', 'tenant-a'],
  ]);
  assert.deepEqual(memoryCalls, [
    ['list', { workspaceId: 'tenant-a' }],
    ['queryLinks', { workspaceId: 'tenant-a' }],
  ]);
});

test('graph-data delegate preserves default scope and memory failure fallback', () => {
  const result = buildGraphData({
    graph: {
      getNodes: workspaceId => workspaceId === 'default' ? {} : { bad: { id: 'bad', weight: 1 } },
      getAllEdges: workspaceId => workspaceId === 'default' ? [] : [{ from: 'bad', to: 'bad' }],
      getEdges: () => [],
    },
    memory: {
      list: () => { throw new Error('storage unavailable'); },
    },
    getSafeMemoryLabel: () => 'unused',
  });

  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.memoryNodes, []);
  assert.deepEqual(result.memoryLinks, []);
  assert.deepEqual(result.metadata, { memory: { enabled: false, reason: 'kernel.memory access error' } });
});
