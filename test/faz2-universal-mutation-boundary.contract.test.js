'use strict';
/**
 * FAZ2-PR1 — Universal Mutation Boundary Contract Tests
 *
 * Purpose: Permanent contract harness documenting the future Universal Mutation
 * Boundary.  These tests do NOT implement the boundary, do NOT bless current
 * unsafe behaviour, and do NOT mutate graph state.
 *
 * Future invariant documented here:
 *   kernel._commitMutation(mutation, context)
 *     → only controlled function that may call graph.addNode / graph.addEdge
 *     → provenance required
 *     → admission default-on
 *     → allow  → write + audit
 *     → review → persistent queue
 *     → reject → audit + drop
 *
 * Tests are green-safe: harness-load and inventory tests pass today; contract
 * invariant tests are registered as skip/todo because the boundary does not
 * exist yet.  Later PRs (FAZ2-2 through FAZ2-7) turn each contract green.
 *
 * Evidence references: docs/audits/faz2-pr1-boundary-red-evidence.md
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Module load — fail-fast if the codebase moved
// ---------------------------------------------------------------------------
const Kernel = require('../kernel');
const Graph = require('../graph');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
}

/**
 * Enumerate every method on graph that writes state (addNode / addEdge
 * variants).  Used by inventory tests.
 */
function graphWriteMethods(graph) {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(graph))
    .filter((m) => m === 'addNode' || m === 'addEdge');
}

// ---------------------------------------------------------------------------
// SECTION 1: Harness sanity — these MUST stay green at all times
// ---------------------------------------------------------------------------
describe('FAZ2-PR1 contract harness: module load', () => {
  it('Kernel class loads without error', () => {
    assert.ok(typeof Kernel === 'function', 'Kernel must be a constructor');
  });

  it('Graph class loads without error', () => {
    assert.ok(typeof Graph === 'function', 'Graph must be a constructor');
  });

  it('Kernel instantiates with noLoad:true, useSQLite:false', () => {
    const k = makeKernel();
    assert.ok(k, 'kernel instance must be truthy');
    assert.ok(k.graph, 'kernel.graph must exist');
  });

  it('kernel.graph exposes addNode and addEdge today (confirming write surface exists)', () => {
    const k = makeKernel();
    const methods = graphWriteMethods(k.graph);
    assert.ok(methods.includes('addNode'), 'graph.addNode must exist');
    assert.ok(methods.includes('addEdge'), 'graph.addEdge must exist');
  });

  it('kernel._commitMutation does not exist today (boundary not yet implemented)', () => {
    const k = makeKernel();
    // This assertion DOCUMENTS the gap, not a desired end state.
    // FAZ2-2 will add _commitMutation; this test will then need to be updated.
    assert.strictEqual(
      typeof k._commitMutation,
      'undefined',
      '_commitMutation must not exist until FAZ2-2 implements it'
    );
  });
});

// ---------------------------------------------------------------------------
// SECTION 2: Background write path inventory (F-001)
// ---------------------------------------------------------------------------
describe('FAZ2-PR1 contract: F-001 background write paths', () => {
  /**
   * These tests document that the named kernel methods exist and can be
   * verified via source-level assertions.  The SKIP tests that follow
   * document the missing gate that FAZ2-2 will add.
   */
  it('kernel exposes _autoThinkTick (background write path F-001-a)', () => {
    const k = makeKernel();
    assert.ok(
      typeof k._autoThinkTick === 'function',
      '_autoThinkTick must exist — it is a confirmed direct addEdge caller'
    );
  });

  it('kernel exposes dream / selfEvolve (background write path F-001-b/c)', () => {
    const k = makeKernel();
    assert.ok(
      typeof k.dream === 'function' || typeof k.selfEvolve === 'function',
      'at least one of dream / selfEvolve must exist'
    );
  });

  it('kernel exposes _crossLink (background write path F-001-d)', () => {
    const k = makeKernel();
    assert.ok(
      typeof k._crossLink === 'function',
      '_crossLink must exist — confirmed direct addEdge caller at kernel.js:1018'
    );
  });

  // CONTRACT: after FAZ2-2, every call to graph.addEdge from background paths
  // must go through _commitMutation.
  it.skip(
    '[FAZ2-2] _autoThinkTick must route addEdge through kernel._commitMutation',
    // Reason: _commitMutation not yet implemented.  FAZ2-2 adds it.
    // Source evidence: kernel.js:1582 — direct graph.addEdge, no gate, no audit.
    () => {
      throw new Error('FAZ2-2 not yet merged');
    }
  );

  it.skip(
    '[FAZ2-2] dream(learnFromDream) must route addEdge through kernel._commitMutation',
    // Source evidence: kernel.js:1671 — direct graph.addEdge, no gate, no audit.
    () => {
      throw new Error('FAZ2-2 not yet merged');
    }
  );

  it.skip(
    '[FAZ2-2] selfEvolve must route addEdge through kernel._commitMutation',
    // Source evidence: kernel.js:2007 — direct graph.addEdge, no gate, no audit.
    () => {
      throw new Error('FAZ2-2 not yet merged');
    }
  );

  it.skip(
    '[FAZ2-2] _crossLink must route addEdge through kernel._commitMutation',
    // Source evidence: kernel.js:1018 — direct graph.addEdge, no gate, no audit.
    () => {
      throw new Error('FAZ2-2 not yet merged');
    }
  );
});

// ---------------------------------------------------------------------------
// SECTION 3: Admission gate default-on (F-002)
// ---------------------------------------------------------------------------
describe('FAZ2-PR1 contract: F-002 admission gate default-on', () => {
  it('[FAZ2-2] kernel.learn defaults admission on without explicit override', () => {
    const k = makeKernel();
    const result = k.learn('test fakt', { workspaceId: 'default' });
    assert.ok(result.ok, 'learn should succeed without admissionRequired');
    assert.strictEqual(result.data.learned, 0, 'default admission review must not write graph');
    assert.strictEqual(result.data.admission?.outcome, 'review');
  });

  // MCP execution stays as a later integration contract because this PR only
  // hardens kernel.learn; it does not change MCP approval execution/persistence.
  it.skip(
    '[FAZ2-5] MCP axiom.learn execution must not bypass default admission',
    // Source evidence: mcpServer.js:757 — kernel.learn called without admissionRequired.
    () => {
      throw new Error('FAZ2-5 not yet merged');
    }
  );
});

// ---------------------------------------------------------------------------
// SECTION 4: Plugin direct write gap (F-003)
// ---------------------------------------------------------------------------
describe('FAZ2-PR1 contract: F-003 plugin direct graph writes', () => {
  it('plugins directory is accessible', () => {
    const pluginsDir = path.join(__dirname, '..', 'plugins');
    const fs = require('fs');
    assert.ok(fs.existsSync(pluginsDir), 'plugins/ directory must exist');
  });

  it('company-brain.js exists (confirmed direct graph writer)', () => {
    const pluginPath = path.join(__dirname, '..', 'plugins', 'company-brain.js');
    const fs = require('fs');
    assert.ok(fs.existsSync(pluginPath), 'company-brain.js must exist');
  });

  it('repo-memory.js exists (confirmed direct graph writer)', () => {
    const pluginPath = path.join(__dirname, '..', 'plugins', 'repo-memory.js');
    const fs = require('fs');
    assert.ok(fs.existsSync(pluginPath), 'repo-memory.js must exist');
  });

  // CONTRACT: after FAZ2-4, plugins must call kernel._commitMutation instead
  // of accessing kernel.graph directly.
  it.skip(
    '[FAZ2-4] company-brain.js must not call kernel.graph.addNode/addEdge directly',
    // Source evidence: plugins/company-brain.js:46-48 — direct kernel.graph.addNode/addEdge.
    () => {
      throw new Error('FAZ2-4 not yet merged');
    }
  );

  it.skip(
    '[FAZ2-4] repo-memory.js must not call kernel.graph.addNode/addEdge directly',
    // Source evidence: plugins/repo-memory.js:42-44 — direct kernel.graph.addNode/addEdge.
    () => {
      throw new Error('FAZ2-4 not yet merged');
    }
  );

  it.skip(
    '[FAZ2-4] /api/ingest must route through admission before calling plugin.run()',
    // Source evidence: lib/ingest.js — plugin.run() called without admission gate.
    () => {
      throw new Error('FAZ2-4 not yet merged');
    }
  );
});

// ---------------------------------------------------------------------------
// SECTION 5: _commitMutation contract shape (future invariant)
// ---------------------------------------------------------------------------
describe('FAZ2-PR1 contract: _commitMutation future interface', () => {
  /**
   * These tests document the REQUIRED interface of _commitMutation once FAZ2-2
   * implements it.  They skip today because the method does not exist.
   */

  it.skip(
    '[FAZ2-2] _commitMutation(mutation, context) must exist on Kernel prototype',
    () => {
      const k = makeKernel();
      assert.strictEqual(typeof k._commitMutation, 'function');
    }
  );

  it.skip(
    '[FAZ2-2] _commitMutation must require non-null provenance in context',
    () => {
      const k = makeKernel();
      assert.throws(
        () => k._commitMutation({ from: 'a', to: 'b', relation: 'r' }, null),
        /provenance/i,
        '_commitMutation must reject null context / missing provenance'
      );
    }
  );

  it.skip(
    '[FAZ2-2] _commitMutation outcome allow must write to graph and emit audit event',
    () => {
      throw new Error('FAZ2-2 not yet merged');
    }
  );

  it.skip(
    '[FAZ2-2] _commitMutation outcome review must enqueue to persistent store, not write graph',
    () => {
      throw new Error('FAZ2-2 not yet merged');
    }
  );

  it.skip(
    '[FAZ2-2] _commitMutation outcome reject must emit audit event and not write graph',
    () => {
      throw new Error('FAZ2-2 not yet merged');
    }
  );
});
