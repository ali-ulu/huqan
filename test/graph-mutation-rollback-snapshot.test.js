'use strict';

/**
 * #1134: runMutationOnce deep-cloned all four pieces of mutable graph state
 * before every mutation, so the cost of *attempting* a mutation scaled with
 * everything the graph held rather than with what the mutation touched.
 *
 * Two of the four never needed a deep copy — an append-only audit log needs a
 * length, and candidate claims are replaced wholesale rather than edited. The
 * cheaper pre-image is only worth anything if rollback still restores exactly,
 * so that is what these tests check, on both backends.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Graph = require('../graph');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-rollback-snapshot-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

let seq = 0;
function makeGraph(backend) {
  seq += 1;
  return new Graph({
    memoryPath: path.join(root, `g${seq}-${backend}.json`),
    dbPath: path.join(root, `g${seq}-${backend}.db`),
    useSQLite: backend === 'sqlite',
  });
}

function auditIds(graph, workspaceId) {
  return graph.getAuditEvents({ workspaceId }).map((event) => event.auditId);
}

for (const backend of ['json', 'sqlite']) {
  test(`[${backend}] a failed mutation drops only the audit events it appended`, () => {
    const graph = makeGraph(backend);

    graph.appendAuditEvent({ eventType: 'UPDATE', targetType: 'node', targetId: 'before-1' }, { workspaceId: 'w' });
    graph.appendAuditEvent({ eventType: 'UPDATE', targetType: 'node', targetId: 'before-2' }, { workspaceId: 'w' });
    const before = auditIds(graph, 'w');
    assert.equal(before.length, 2);

    assert.throws(() => graph.runMutationOnce('rollback-audit', () => {
      graph.appendAuditEvent({ eventType: 'LEARN', targetType: 'node', targetId: 'during' }, { workspaceId: 'w' });
      throw new Error('forced failure');
    }), /forced failure/);

    // Truncated to the pre-image length: the appended one is gone, the older
    // ones survive unchanged and in order.
    assert.deepStrictEqual(auditIds(graph, 'w'), before);

    // ...and the log is still usable afterwards.
    graph.appendAuditEvent({ eventType: 'UPDATE', targetType: 'node', targetId: 'after' }, { workspaceId: 'w' });
    assert.equal(auditIds(graph, 'w').length, 3);
  });

  test(`[${backend}] a successful mutation keeps the audit events it appended`, () => {
    const graph = makeGraph(backend);

    const result = graph.runMutationOnce('commit-audit', () => {
      graph.appendAuditEvent({ eventType: 'LEARN', targetType: 'node', targetId: 'kept' }, { workspaceId: 'w' });
      return { ok: true };
    });

    assert.equal(result.replayed, false);
    assert.deepStrictEqual(
      graph.getAuditEvents({ workspaceId: 'w' }).map((event) => event.targetId),
      ['kept'],
    );
  });

  test(`[${backend}] a failed mutation rolls back candidate claims, added and replaced alike`, () => {
    const graph = makeGraph(backend);

    graph.addCandidateClaim({
      candidateId: 'c-1', claim: 'original', workspaceId: 'w', recommendation: 'accept', status: 'pending',
    }, { workspaceId: 'w' });
    const before = graph.getCandidateClaims({ workspaceId: 'w' });
    assert.equal(before.length, 1);
    assert.equal(before[0].claim, 'original');

    assert.throws(() => graph.runMutationOnce('rollback-claims', () => {
      // One replace of the existing claim, one append of a new one.
      graph.addCandidateClaim({
        candidateId: 'c-1', claim: 'overwritten', workspaceId: 'w', recommendation: 'accept', status: 'pending',
      }, { workspaceId: 'w' });
      graph.addCandidateClaim({
        candidateId: 'c-2', claim: 'added', workspaceId: 'w', recommendation: 'accept', status: 'pending',
      }, { workspaceId: 'w' });
      throw new Error('forced failure');
    }), /forced failure/);

    const restored = graph.getCandidateClaims({ workspaceId: 'w' });
    assert.equal(restored.length, 1, 'the appended claim is gone');
    assert.equal(restored[0].candidateId, 'c-1');
    assert.equal(restored[0].claim, 'original', 'the replaced claim is back to its pre-image');
  });

  test(`[${backend}] a failed mutation still rolls back nodes and edges`, () => {
    const graph = makeGraph(backend);
    graph.addNode('a', 'A', null, { workspaceId: 'w' });
    graph.addNode('b', 'B', null, { workspaceId: 'w' });
    graph.addEdge('a', 'b', 'tur', { workspaceId: 'w', strength: 0.5, confidence: 0.5, source: 'manual' });
    const weightBefore = graph.getNode('a', 'w').weight;

    assert.throws(() => graph.runMutationOnce('rollback-graph', () => {
      graph.addNode('phantom', 'Phantom', null, { workspaceId: 'w' });
      graph.addEdge('a', 'phantom', 'tur', { workspaceId: 'w', strength: 0.9, confidence: 0.9, source: 'manual' });
      // In-place edit of an existing record: this is why nodes/edges are still
      // copied rather than tracked by length.
      graph.addNode('a', 'A', null, { workspaceId: 'w' });
      throw new Error('forced failure');
    }), /forced failure/);

    assert.equal(graph.getNode('phantom', 'w'), null);
    assert.equal(graph.getEdges('a', 'w').length, 1, 'only the original edge remains');
    assert.equal(graph.getNode('a', 'w').weight, weightBefore, 'the in-place weight bump is undone');
  });
}
