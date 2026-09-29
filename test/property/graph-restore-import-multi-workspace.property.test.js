'use strict';

/**
 * #3011 property: multi-workspace graph restore and import.
 *
 * test/property/graph-multi-workspace-persistence.property.test.js covers the
 * incremental *save* path: a mutation's delta must stay inside the workspace
 * that was mutated. This file owns the two paths that move a whole graph
 * across a store boundary, where a per-workspace mistake is much harder to
 * see than in a save:
 *
 *   1. Import -- a JSON-era graph is adopted by the SQLite backend when the
 *      database is empty (lib/graph-json-persistence.js, the JSON mirror is
 *      the adoption/export artifact). Adoption writes every record it reads;
 *      if it keys records by node id alone, two workspaces that reuse the
 *      same id collapse into one and the loss is silent.
 *   2. Restore -- `restoreBackup` replaces the database with a copy taken
 *      earlier. A restore that restores one workspace's rows over another's,
 *      or that loses a workspace the backup contained, has to be caught here;
 *      the workspace-scoped assertions in the save test cannot see it, because
 *      they never cross a file boundary.
 *
 * Both assertions compare against an INDEPENDENT reference model (a plain
 * Map/Set per workspace maintained alongside the graph), not against the
 * graph's own bookkeeping. Comparing Graph to Graph would pass even if both
 * sides were wrong the same way.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const Graph = require('../../graph');
const { createBackup, restoreBackup } = require('../../backupRestore');
const { normalizeWorkspaceId } = require('../../lib/graph-record-utils');

const NUM_RUNS = 40;
const NODE_IDS = ['n0', 'n1', 'n2'];
const MAX_WORKSPACES = 4;
const RELATION = 'relates';
const SEED_EDGES = Object.freeze([['n0', 'n1'], ['n1', 'n2']]);

const workspaceArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/);

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupRoot(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function graphOptions(root, useSQLite) {
  return {
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite,
  };
}

/** Builds the independent reference: one entry per workspace. */
function createReference(workspaces) {
  const model = new Map();
  for (const workspace of workspaces) {
    const nodes = new Map();
    for (const id of NODE_IDS) nodes.set(id, `${workspace}-${id}`);
    const edges = new Set(SEED_EDGES.map(([a, b]) => `${a}|${RELATION}|${b}`));
    model.set(normalizeWorkspaceId(workspace), { nodes, edges });
  }
  return model;
}

function writeGraph(graph, workspaces) {
  for (const workspace of workspaces) {
    for (const id of NODE_IDS) {
      graph.addNode(id, `${workspace}-${id}`, null, { workspaceId: workspace });
    }
    for (const [a, b] of SEED_EDGES) {
      graph.addEdge(a, b, RELATION, { workspaceId: workspace, weight: 0.5 });
    }
  }
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

// Enumerates observable state through the public API, so the assertion never
// reaches into private state.
function nodeLabelsOf(graph, workspace, nodeIds) {
  const scope = normalizeWorkspaceId(workspace);
  const labels = {};
  for (const id of nodeIds) {
    const node = graph.getNode(id, scope);
    if (node) labels[id] = node.label;
  }
  return labels;
}

function edgesOf(graph, workspace, nodeIds) {
  const scope = normalizeWorkspaceId(workspace);
  const found = new Set();
  for (const id of nodeIds) {
    for (const edge of graph.getEdges(id, scope)) {
      if (normalizeWorkspaceId(edge.workspaceId) !== scope) continue;
      found.add(`${edge.from}|${edge.relation}|${edge.to}`);
    }
  }
  return [...found].sort();
}

/** Asserts a live graph matches the reference for every workspace. */
function assertMatchesReference(graph, workspaces, model, context) {
  for (const workspace of workspaces) {
    const expected = snapshotReference(model)[normalizeWorkspaceId(workspace)];
    const labels = nodeLabelsOf(graph, workspace, NODE_IDS);
    assert.deepEqual(
      Object.keys(labels).sort(),
      expected.nodes,
      `${context}: workspace ${workspace} node set must match the reference`,
    );
    for (const id of expected.nodes) {
      assert.equal(
        labels[id],
        `${workspace}-${id}`,
        `${context}: workspace ${workspace} node ${id} must keep its own label`,
      );
    }
    assert.equal(
      graph.nodeCount(workspace),
      expected.nodes.length,
      `${context}: workspace ${workspace} nodeCount must match the reference`,
    );
    assert.deepEqual(
      edgesOf(graph, workspace, NODE_IDS),
      expected.edges,
      `${context}: workspace ${workspace} edge set must match the reference`,
    );
    assert.equal(
      graph.edgeCount(workspace),
      expected.edges.length,
      `${context}: workspace ${workspace} edgeCount must match the reference`,
    );
  }
}

describe('property: multi-workspace graph restore and import (#3011)', () => {
  it('a JSON-era graph imports into SQLite with every workspace kept separate', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(workspaceArb, { minLength: 2, maxLength: MAX_WORKSPACES }),
        workspaces => {
          const root = makeRoot('huqan-ws-import-');
          try {
            // The JSON-era source graph. Each workspace reuses the same node
            // ids on purpose: this is where an id-only key collapses them.
            const seed = new Graph(graphOptions(root, false));
            try {
              if (seed._storePort.backend() !== 'json') return;
              writeGraph(seed, workspaces);
              seed.save();
            } finally {
              seed.close();
            }

            const model = createReference(workspaces);
            const adopted = new Graph(graphOptions(root, true));
            try {
              if (adopted.getStats().backend !== 'sqlite') return; // better-sqlite3 unavailable
              // Empty database: load falls back to the JSON mirror and adopts it.
              adopted.load();
              assertMatchesReference(adopted, workspaces, model, 'import');
            } finally {
              adopted.close();
            }
          } finally {
            cleanupRoot(root);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('a backup restore returns every workspace to its backed-up state', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(workspaceArb, { minLength: 2, maxLength: MAX_WORKSPACES }),
        fc.constantFrom(...NODE_IDS),
        (workspaces, removedId) => {
          const root = makeRoot('huqan-ws-restore-');
          const opts = {
            rootDir: root,
            memoryPath: path.join(root, 'memory.json'),
            dbPath: path.join(root, 'memory.db'),
            backupBaseDir: path.join(root, 'backups'),
          };
          try {
            const model = createReference(workspaces);
            const built = new Graph(graphOptions(root, true));
            try {
              if (built.getStats().backend !== 'sqlite') return;
              writeGraph(built, workspaces);
              built.save();
            } finally {
              built.close();
            }
            const before = snapshotReference(model);

            const backup = createBackup({ ...opts, keepLast: 5 });
            assert.ok(
              backup.manifest.files.includes('memory.db'),
              'the backup must contain the SQLite database',
            );

            // Destructively mutate every workspace, so a restore that silently
            // skips one workspace cannot pass.
            const mutated = new Graph(graphOptions(root, true));
            try {
              mutated.load();
              for (const workspace of workspaces) {
                assert.ok(
                  mutated.removeNode(removedId, workspace),
                  `mutation must remove ${removedId} from ${workspace}`,
                );
              }
              mutated.save();
            } finally {
              mutated.close();
            }

            const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
            assert.equal(restored.verification.graphIntegrity, true, 'restore must verify graph integrity');

            const reloaded = new Graph(graphOptions(root, true));
            try {
              reloaded.load();
              for (const workspace of workspaces) {
                const scope = normalizeWorkspaceId(workspace);
                assert.deepEqual(
                  {
                    nodes: Object.keys(nodeLabelsOf(reloaded, workspace, NODE_IDS)).sort(),
                    edges: edgesOf(reloaded, workspace, NODE_IDS),
                  },
                  before[scope],
                  `restored workspace ${workspace} must equal its backed-up state`,
                );
              }
            } finally {
              reloaded.close();
            }
          } finally {
            cleanupRoot(root);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
