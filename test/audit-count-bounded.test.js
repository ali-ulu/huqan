const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');
const { captureGraphEvidenceForTest } = require('../lib/workbench/ingest-approval-action');

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-audit-count-'));
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function seed(graph, count, workspaceId = 'default') {
  for (let i = 0; i < count; i++) {
    graph.appendAuditEvent({
      eventType: 'memory.write',
      targetType: 'node',
      targetId: `n-${workspaceId}-${i}`,
      workspaceId,
      actor: i % 2 === 0 ? 'system' : 'operator',
    });
  }
}

function makeGraph(name, useSQLite) {
  return new Graph({
    memoryPath: path.join(tempDir, `${name}.json`),
    useSQLite,
    noLoad: true,
  });
}

describe('Graph.countAuditEvents is bounded (#728)', () => {
  it('matches getAuditEvents().length with no filter, on SQLite', () => {
    const graph = makeGraph('sqlite-nofilter', true);
    seed(graph, 40);
    assert.strictEqual(graph.countAuditEvents({}), graph.getAuditEvents({}).length);
    assert.strictEqual(graph.countAuditEvents({}), 40);
  });

  it('matches getAuditEvents().length with no filter, without SQLite', () => {
    const graph = makeGraph('json-nofilter', false);
    seed(graph, 12);
    assert.strictEqual(graph.countAuditEvents({}), graph.getAuditEvents({}).length);
    assert.strictEqual(graph.countAuditEvents({}), 12);
  });

  it('scopes by workspace rather than counting unrelated workspaces', () => {
    const graph = makeGraph('workspace-scope', true);
    seed(graph, 7, 'default');
    seed(graph, 5, 'tenant-a');
    seed(graph, 3, 'tenant-b');

    assert.strictEqual(graph.countAuditEvents({}), 15);
    assert.strictEqual(graph.countAuditEvents({ workspaceId: 'default' }), 7);
    assert.strictEqual(graph.countAuditEvents({ workspaceId: 'tenant-a' }), 5);
    assert.strictEqual(graph.countAuditEvents({ workspaceId: 'tenant-b' }), 3);
    assert.strictEqual(graph.countAuditEvents({ workspaceId: 'absent' }), 0);
  });

  it('agrees with the filtering path across every supported filter', () => {
    const graph = makeGraph('filter-parity', true);
    seed(graph, 9, 'default');
    seed(graph, 6, 'tenant-a');

    const filterSets = [
      {},
      { workspaceId: 'default' },
      { workspaceId: 'tenant-a' },
      { eventType: 'memory.write' },
      { eventType: 'memory.absent' },
      { actor: 'system' },
      { actor: 'operator' },
      { targetType: 'node' },
      { targetId: 'n-default-3' },
      { eventType: 'memory.write', workspaceId: 'tenant-a', actor: 'system' },
    ];

    for (const filters of filterSets) {
      assert.strictEqual(
        graph.countAuditEvents(filters),
        graph.getAuditEvents(filters).length,
        `count/filter mismatch for ${JSON.stringify(filters)}`,
      );
    }
  });

  it('does not materialize audit rows for a count', () => {
    const graph = makeGraph('no-materialize', true);
    seed(graph, 200);

    let materialized = 0;
    const originalAll = graph._stmts.allAuditEvents.all.bind(graph._stmts.allAuditEvents);
    graph._stmts.allAuditEvents.all = (...args) => {
      materialized += 1;
      return originalAll(...args);
    };

    try {
      assert.strictEqual(graph.countAuditEvents({}), 200);
      assert.strictEqual(graph.countAuditEvents({ workspaceId: 'default' }), 200);
      assert.strictEqual(materialized, 0, 'countAuditEvents must not read audit rows');

      assert.strictEqual(graph.getAuditEvents({}).length, 200);
      assert.strictEqual(materialized, 1, 'getAuditEvents is still the materializing path');
    } finally {
      graph._stmts.allAuditEvents.all = originalAll;
    }
  });

  it('falls back to the exact path when memory holds events the table does not', () => {
    const graph = makeGraph('memory-ahead', true);
    seed(graph, 4);

    // Simulates events buffered before a database was attached: present in the
    // in-memory mirror, absent from audit_log.
    graph._auditEvents.push({
      auditId: 'memory-only-1',
      eventType: 'memory.write',
      targetType: 'node',
      targetId: 'memory-only',
      workspaceId: 'default',
      actor: 'system',
      timestamp: new Date().toISOString(),
      sourceRef: '',
      provenanceId: '',
      trustPolicyVersion: '',
      details: {},
    });

    assert.strictEqual(graph.countAuditEvents({}), graph.getAuditEvents({}).length);
    assert.strictEqual(graph.countAuditEvents({}), 5);
  });
});

describe('ingest approval evidence uses the bounded count (#728)', () => {
  it('captures evidence without materializing the audit log', () => {
    const graph = makeGraph('evidence', true);
    seed(graph, 150);

    let materialized = 0;
    const originalAll = graph._stmts.allAuditEvents.all.bind(graph._stmts.allAuditEvents);
    graph._stmts.allAuditEvents.all = (...args) => {
      materialized += 1;
      return originalAll(...args);
    };

    try {
      const evidence = captureGraphEvidenceForTest({ graph });
      assert.strictEqual(evidence.ok, true);
      assert.strictEqual(evidence.auditCount, 150);
      assert.strictEqual(materialized, 0, 'evidence capture must not read audit rows');
    } finally {
      graph._stmts.allAuditEvents.all = originalAll;
    }
  });

  it('reports evidence unavailable when the graph cannot answer', () => {
    const evidence = captureGraphEvidenceForTest({
      graph: {
        getStats() { throw new Error('unavailable'); },
      },
    });
    assert.strictEqual(evidence.ok, false);
  });
});
