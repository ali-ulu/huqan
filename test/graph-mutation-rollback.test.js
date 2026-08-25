'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Graph = require('../graph');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-rollback-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

function makeGraph(name, backend) {
  return new Graph({
    memoryPath: path.join(root, `${name}-${backend}.json`),
    dbPath: path.join(root, `${name}-${backend}.db`),
    useSQLite: backend === 'sqlite',
  });
}

for (const backend of ['sqlite', 'json']) {
  test(`[${backend}] lazy rollback restores every supported in-memory write path`, () => {
    const graph = makeGraph('all-writes', backend);
    graph.addNode('a', 'A', null, { workspaceId: 'w' });
    graph.addNode('b', 'B', null, { workspaceId: 'w' });
    graph.addEdge('a', 'b', 'is_a', {
      workspaceId: 'w',
      weight: 0.7,
      confidence: 0.7,
      evidence: ['seed'],
    });
    graph.addCandidateClaim({
      candidateId: 'c-1',
      claim: 'original',
      workspaceId: 'w',
      recommendation: 'accept',
      status: 'pending',
    }, { workspaceId: 'w' });
    graph.appendAuditEvent({ eventType: 'SEED', targetType: 'node', targetId: 'a' }, { workspaceId: 'w' });

    const before = {
      node: graph.getNode('a', 'w'),
      otherNode: graph.getNode('b', 'w'),
      edge: graph.getEdge('a', 'b', 'is_a', 'w'),
      candidates: graph.getCandidateClaims({ workspaceId: 'w' }),
      audit: graph.getAuditEvents({ workspaceId: 'w' }),
    };

    assert.throws(() => graph.runMutationOnce('lazy-rollback', () => {
      graph.addNode('a', 'A reinforced', { source: 'during' }, { workspaceId: 'w' });
      graph.addTag('a', 'during', 2, 'w');
      graph.touchNode('a', 'w');
      graph.addEdge('a', 'b', 'is_a', {
        workspaceId: 'w',
        weight: 0.9,
        confidence: 0.9,
        evidence: ['during'],
      });
      graph.downgradeEdge({
        fromId: 'a',
        toId: 'b',
        relation: 'is_a',
        workspaceId: 'w',
        weight: 0.1,
        marker: 'during',
      });

      const scope = graph._captureTemporalEdgeKeys();
      graph.addEdge('a', 'b', 'is_a', { workspaceId: 'w', evidence: ['temporal'] });
      graph._applyTemporalEdgeMetadata('during-temporal', '2026-08-25T00:00:00.000Z', scope, { workspaceId: 'w' });

      graph.addCandidateClaim({
        candidateId: 'c-1',
        claim: 'replaced',
        workspaceId: 'w',
        recommendation: 'accept',
        status: 'pending',
      }, { workspaceId: 'w' });
      graph.addCandidateClaim({
        candidateId: 'c-2',
        claim: 'appended',
        workspaceId: 'w',
        recommendation: 'review',
        status: 'pending',
      }, { workspaceId: 'w' });
      graph.removeNode('b', 'w');
      graph.appendAuditEvent({ eventType: 'DURING', targetType: 'node', targetId: 'a' }, { workspaceId: 'w' });
      throw new Error('forced lazy rollback');
    }), /forced lazy rollback/);

    assert.deepEqual(graph.getNode('a', 'w'), before.node, 'node and nested vector/provenance state restored');
    assert.deepEqual(graph.getNode('b', 'w'), before.otherNode, 'node delete rollback leaves b readable');
    assert.deepEqual(graph.getEdge('a', 'b', 'is_a', 'w'), before.edge, 'edge and nested history/evidence state restored');
    assert.deepEqual(graph.getCandidateClaims({ workspaceId: 'w' }), before.candidates, 'candidate replace/append state restored');
    assert.deepEqual(graph.getAuditEvents({ workspaceId: 'w' }), before.audit, 'audit append-only tail restored');
  });
}

test('runMutationOnce no longer takes graph-wide deep snapshot clones', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
  assert.match(source, /createMutationRollback/);
  assert.doesNotMatch(source, /cloneNodeMap\(this\._nodes\)/);
  assert.doesNotMatch(source, /deepClone\(this\._edges\)/);
  assert.doesNotMatch(source, /deepClone\(this\._candidateClaims\)/);
  assert.doesNotMatch(source, /deepClone\(this\._auditEvents\)/);
});
