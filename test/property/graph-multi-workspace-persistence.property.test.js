'use strict';

/**
 * #3011 property: multi-workspace incremental graph persistence.
 *
 * The incremental-save path writes only the records a mutation touched. The
 * unit tests in test/graph-incremental-save.test.js pin that on the default
 * workspace; this file pins the part a single-workspace test cannot see:
 * whether the delta is scoped to the workspace that was mutated. A delta that
 * leaks across workspaces -- a row stamped with the wrong workspace, a
 * cross-workspace node key welded together, an incident-edge cascade that
 * reaches into a neighbouring workspace -- is exactly the failure an
 * incremental save can introduce and a full rewrite cannot.
 *
 * The assertion is against an INDEPENDENT reference model, not against the
 * graph's own bookkeeping: the test maintains its own Map/Set of nodes and
 * edges per workspace, mutates the graph and the reference in lockstep, and
 * compares the reloaded graph to the reference. Comparing Graph to Graph would
 * pass even if both sides were wrong the same way.
 *
 * Two invariants are asserted after every mutation + incremental save +
 * reload:
 *   1. Every workspace's node/edge set equals the reference exactly.
 *   2. The mutation is visible only in its own workspace: every other
 *      workspace's observable state is byte-for-byte what it was before.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const Graph = require('../../graph');
const { normalizeWorkspaceId } = require('../../lib/graph-record-utils');

const NUM_RUNS = 100;
const NODE_IDS = ['n0', 'n1', 'n2', 'n3', 'n4'];
const MAX_WORKSPACES = 4;
const RELATION = 'relates';

// One workspace id, unique within a property run.
const workspaceArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/);

// A mutation the test applies to exactly one workspace.
const mutationArb = fc.oneof(
  fc.record({ kind: fc.constant('addNode'), a: fc.constantFrom(...NODE_IDS) }),
  fc.record({ kind: fc.constant('addEdge'), a: fc.constantFrom(...NODE_IDS), b: fc.constantFrom(...NODE_IDS) }),
  fc.record({ kind: fc.constant('removeNode'), a: fc.constantFrom(...NODE_IDS) }),
);

function tempGraph() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ws-property-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  });
  return {
    graph,
    cleanup() {
      try { graph.close(); } catch (_) { /* cleanup must not mask a failure */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Enumerates every edge observable in a workspace through the public API, so
// the assertion does not reach into private state.
function edgesOf(graph, workspaceId, nodeIds) {
  const scope = normalizeWorkspaceId(workspaceId);
  const found = new Set();
  for (const id of nodeIds) {
    for (const edge of graph.getEdges(id, scope)) {
      if (normalizeWorkspaceId(edge.workspaceId) !== scope) continue;
      found.add(`${edge.from}|${edge.relation}|${edge.to}`);
    }
  }
  return [...found].sort();
}

function nodeLabelsOf(graph, workspaceId, nodeIds) {
  const scope = normalizeWorkspaceId(workspaceId);
  const labels = {};
  for (const id of nodeIds) {
    const node = graph.getNode(id, scope);
    if (node) labels[id] = node.label;
  }
  return labels;
}

// The independent reference model, mutated in lockstep with the graph.
function createReference(workspaces, nodeIds, seedEdges) {
  const model = new Map();
  for (const workspace of workspaces) {
    const nodes = new Map();
    for (const id of nodeIds) nodes.set(id, `${workspace}-${id}`);
    const edges = new Set(seedEdges.map(([a, b]) => `${a}|${RELATION}|${b}`));
    model.set(workspace, { nodes, edges });
  }
  return model;
}

function applyMutation(graph, model, workspaceId, mutation) {
  const scope = normalizeWorkspaceId(workspaceId);
  const entry = model.get(scope);
  if (mutation.kind === 'addNode') {
    graph.addNode(mutation.a, `${scope}-${mutation.a}`, null, { workspaceId: scope });
    entry.nodes.set(mutation.a, `${scope}-${mutation.a}`);
  } else if (mutation.kind === 'addEdge') {
    const created = graph.addEdge(mutation.a, mutation.b, RELATION, { workspaceId: scope, weight: 0.5 });
    if (created) entry.edges.add(`${mutation.a}|${RELATION}|${mutation.b}`);
  } else {
    const removed = graph.removeNode(mutation.a, scope);
    if (!removed) return false;
    entry.nodes.delete(mutation.a);
    for (const key of [...entry.edges]) {
      const [from, , to] = key.split('|');
      if (from === mutation.a || to === mutation.a) entry.edges.delete(key);
    }
  }
  return true;
}

function snapshotReference(model) {
  const snapshot = {};
  for (const [workspace, entry] of model) {
    snapshot[workspace] = {
      nodes: [...entry.nodes.keys()].sort(),
      edges: [...entry.edges].sort(),
    };
  }
  return snapshot;
}

describe('property: multi-workspace graph persistence (#3011)', () => {
  it('an incremental save scopes its delta to the mutated workspace', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(workspaceArb, { minLength: 2, maxLength: MAX_WORKSPACES }),
        fc.constantFrom(...NODE_IDS),
        mutationArb,
        fc.integer({ min: 0, max: 2 }),
        (workspaces, targetId, mutation, targetIndex) => {
          const target = workspaces[targetIndex % workspaces.length];
          const seedEdges = [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3']];
          const model = createReference(workspaces, NODE_IDS, seedEdges);
          const { graph, cleanup } = tempGraph();
          try {
            if (graph.getStats().backend !== 'sqlite') return; // better-sqlite3 unavailable

            for (const workspace of workspaces) {
              for (const id of NODE_IDS) {
                graph.addNode(id, `${workspace}-${id}`, null, { workspaceId: workspace });
              }
              for (const [a, b] of seedEdges) {
                graph.addEdge(a, b, RELATION, { workspaceId: workspace, weight: 0.5 });
              }
            }

            // The checkpoint everything is compared against.
            graph.save();
            const before = snapshotReference(model);

            if (!applyMutation(graph, model, target, mutation)) return; // no-op mutation

            // The incremental save under test.
            graph.save();

            const after = snapshotReference(model);

            // Live check, before any reload: a mutation in one workspace must
            // not disturb another workspace's in-memory view. A cascade that
            // drops a same-id node's incident edges globally rather than within
            // its own workspace is visible here even though the durable row
            // survives to the reload below.
            for (const workspace of workspaces) {
              const expected = after[workspace];
              assert.deepEqual(
                Object.keys(nodeLabelsOf(graph, workspace, NODE_IDS)).sort(),
                expected.nodes,
                `live workspace ${workspace}: node set must match the reference`,
              );
              assert.deepEqual(
                edgesOf(graph, workspace, NODE_IDS),
                expected.edges,
                `live workspace ${workspace}: edge set must match the reference`,
              );
            }

            // Reload from disk into a fresh instance: this is what proves the
            // delta was durably and correctly scoped, not merely held in memory.
            const reloaded = new Graph({
              memoryPath: graph.memoryPath,
              dbPath: graph._paths.dbPath,
              useSQLite: true,
            });
            try {
              reloaded.load();

              for (const workspace of workspaces) {
                const expected = after[workspace];
                const actualNodes = nodeLabelsOf(reloaded, workspace, NODE_IDS);
                assert.deepEqual(
                  Object.keys(actualNodes).sort(),
                  expected.nodes,
                  `workspace ${workspace}: node set must match the reference`,
                );
                for (const id of expected.nodes) {
                  assert.equal(
                    actualNodes[id],
                    `${workspace}-${id}`,
                    `workspace ${workspace}: node ${id} must keep its own label`,
                  );
                }
                assert.equal(
                  reloaded.nodeCount(workspace),
                  expected.nodes.length,
                  `workspace ${workspace}: nodeCount must match the reference`,
                );
                assert.deepEqual(
                  edgesOf(reloaded, workspace, NODE_IDS),
                  expected.edges,
                  `workspace ${workspace}: edge set must match the reference`,
                );
                assert.equal(
                  reloaded.edgeCount(workspace),
                  expected.edges.length,
                  `workspace ${workspace}: edgeCount must match the reference`,
                );
              }

              // Isolation: every non-target workspace is exactly what it was
              // before the mutation. The target's own rows are allowed to move.
              for (const workspace of workspaces) {
                if (normalizeWorkspaceId(workspace) === normalizeWorkspaceId(target)) continue;
                assert.deepEqual(
                  after[workspace],
                  before[workspace],
                  `workspace ${workspace} must be untouched by a mutation in ${target}`,
                );
              }
            } finally {
              reloaded.close();
            }
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
