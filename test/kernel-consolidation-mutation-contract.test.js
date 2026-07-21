const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');

function isolatedKernelOptions(root) {
  return {
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  };
}

function closeKernel(kernel) {
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

function withKernel(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-kernel-consolidate-'));
  let kernel;
  try {
    kernel = new Kernel(isolatedKernelOptions(root));
    return run(kernel);
  } finally {
    closeKernel(kernel);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function edge(from, to, relation, weight, extra = {}) {
  return {
    from,
    to,
    relation,
    weight,
    workspaceId: 'default',
    ...extra,
  };
}

function replaceMethods(target, replacements, run) {
  const originals = new Map();
  for (const [name, replacement] of Object.entries(replacements)) {
    originals.set(name, target[name]);
    target[name] = replacement;
  }

  try {
    return run();
  } finally {
    for (const [name, original] of originals) {
      target[name] = original;
    }
  }
}

function installGraphMutationSpies(graph, options = {}) {
  const originalRebuildIndex = graph._rebuildIndex;
  const calls = {
    rebuild: [],
    save: [],
  };

  const restore = replaceMethods.bind(null, graph, {
    _rebuildIndex(...args) {
      calls.rebuild.push(args);
      return originalRebuildIndex.apply(this, args);
    },
    save(...args) {
      calls.save.push(args);
      if (options.saveThrows) throw options.saveThrows;
      return options.saveResult;
    },
  });

  return { calls, restore };
}

function assertRemovalDetail(detail, expected) {
  assert.match(
    detail,
    new RegExp(`^${expected.from} .+ ${expected.to} \\(${expected.relation}, w:${expected.weight}\\): `),
  );
  for (const fragment of expected.fragments) {
    assert.ok(detail.includes(fragment), `expected detail to include ${fragment}: ${detail}`);
  }
}

test('consolidate dry-run returns exact removal order without replacing, rebuilding, or saving', { concurrency: false }, () => {
  withKernel(kernel => {
    const pairHigh = edge('pair-subject', 'pair-object', 'kept', 0.9);
    const pairLowOne = edge('pair-subject', 'pair-object', 'stale', 0.2);
    const pairLowTwo = edge('pair-subject', 'pair-object', 'weaker', 0.1);
    const relationHigh = edge('rel-subject', 'rel-kept', 'supports', 0.7);
    const relationLow = edge('rel-subject', 'rel-removed', 'supports', 0.25);
    const protectedLow = edge('rel-subject', 'rel-protected', 'supports', 0.05, { kistlama: true });
    const originalEdges = [pairHigh, pairLowOne, pairLowTwo, relationHigh, relationLow, protectedLow];
    kernel.graph._edges = originalEdges;

    const { calls, restore } = installGraphMutationSpies(kernel.graph);
    restore(() => {
      const result = kernel.consolidate(true);

      assert.deepStrictEqual(
        { dryRun: result.dryRun, removed: result.removed, detailCount: result.details.length },
        { dryRun: true, removed: 3, detailCount: 3 },
      );
      assertRemovalDetail(result.details[0], {
        from: 'pair-subject',
        to: 'pair-object',
        relation: 'stale',
        weight: 0.2,
        fragments: ['low-weight (0.2)', 'high-weight (0.9)', 'same pair'],
      });
      assertRemovalDetail(result.details[1], {
        from: 'pair-subject',
        to: 'pair-object',
        relation: 'weaker',
        weight: 0.1,
        fragments: ['low-weight (0.1)', 'high-weight (0.9)', 'same pair'],
      });
      assertRemovalDetail(result.details[2], {
        from: 'rel-subject',
        to: 'rel-removed',
        relation: 'supports',
        weight: 0.25,
        fragments: ['low-weight restriction (0.25)', "subject already has high-weight 'supports'"],
      });
      assert.deepStrictEqual(result.details, [
        'pair-subject ? pair-object (stale, w:0.2): low-weight (0.2) superseded by high-weight (0.9) for same pair',
        'pair-subject ? pair-object (weaker, w:0.1): low-weight (0.1) superseded by high-weight (0.9) for same pair',
        "rel-subject ? rel-removed (supports, w:0.25): low-weight restriction (0.25) \u00e2\u20ac\u201d subject already has high-weight 'supports'",
      ]);

      assert.strictEqual(kernel.graph._edges, originalEdges);
      assert.deepStrictEqual(kernel.graph._edges, [
        pairHigh,
        pairLowOne,
        pairLowTwo,
        relationHigh,
        relationLow,
        protectedLow,
      ]);
      assert.deepStrictEqual(calls, { rebuild: [], save: [] });
    });
  });
});

test('consolidate apply preserves retained edge identity and order, rebuilds once, and saves once', { concurrency: false }, () => {
  withKernel(kernel => {
    const before = edge('before', 'target', 'kept-before', 0.4);
    const pairHigh = edge('pair-subject', 'pair-object', 'kept', 0.8);
    const pairLow = edge('pair-subject', 'pair-object', 'stale', 0.2);
    const middle = edge('middle', 'target', 'kept-middle', 0.4);
    const relationHigh = edge('rel-subject', 'rel-kept', 'supports', 0.7);
    const relationLow = edge('rel-subject', 'rel-removed', 'supports', 0.1);
    const after = edge('after', 'target', 'kept-after', 0.4);
    const originalEdges = [before, pairHigh, pairLow, middle, relationHigh, relationLow, after];
    kernel.graph._edges = originalEdges;

    const { calls, restore } = installGraphMutationSpies(kernel.graph);
    restore(() => {
      const result = kernel.consolidate(false);

      assert.deepStrictEqual(
        { dryRun: result.dryRun, removed: result.removed, detailCount: result.details.length },
        { dryRun: false, removed: 2, detailCount: 2 },
      );
      assert.notStrictEqual(kernel.graph._edges, originalEdges);
      assert.deepStrictEqual(kernel.graph._edges, [before, pairHigh, middle, relationHigh, after]);
      assert.strictEqual(kernel.graph._edges[0], before);
      assert.strictEqual(kernel.graph._edges[1], pairHigh);
      assert.strictEqual(kernel.graph._edges[2], middle);
      assert.strictEqual(kernel.graph._edges[3], relationHigh);
      assert.strictEqual(kernel.graph._edges[4], after);
      assert.deepStrictEqual(calls.rebuild, [[]]);
      assert.deepStrictEqual(calls.save, [[]]);
    });
  });
});

test('consolidate apply with no removals does not replace, rebuild, or save', { concurrency: false }, () => {
  withKernel(kernel => {
    const high = edge('subject', 'object', 'kept', 0.7);
    const lowWithoutPeer = edge('low', 'other', 'unsupported', 0.1);
    const protectedLow = edge('subject', 'object', 'protected', 0.05, { kistlama: true });
    const originalEdges = [high, lowWithoutPeer, protectedLow];
    kernel.graph._edges = originalEdges;

    const { calls, restore } = installGraphMutationSpies(kernel.graph);
    restore(() => {
      const result = kernel.consolidate(false);

      assert.deepStrictEqual(result, { dryRun: false, removed: 0, details: [] });
      assert.strictEqual(kernel.graph._edges, originalEdges);
      assert.deepStrictEqual(kernel.graph._edges, [high, lowWithoutPeer, protectedLow]);
      assert.deepStrictEqual(calls, { rebuild: [], save: [] });
    });
  });
});

test('consolidate save errors are logged and swallowed after in-memory mutation', { concurrency: false }, () => {
  withKernel(kernel => {
    const pairHigh = edge('subject', 'object', 'kept', 0.9);
    const pairLow = edge('subject', 'object', 'stale', 0.2);
    kernel.graph._edges = [pairHigh, pairLow];
    const saveError = new Error('disk full');
    const logged = [];
    const originalConsoleError = console.error;

    const { calls, restore } = installGraphMutationSpies(kernel.graph, { saveThrows: saveError });
    console.error = (...args) => logged.push(args);
    try {
      restore(() => {
        let result;
        assert.doesNotThrow(() => {
          result = kernel.consolidate(false);
        });

        assert.deepStrictEqual(
          { dryRun: result.dryRun, removed: result.removed, detailCount: result.details.length },
          { dryRun: false, removed: 1, detailCount: 1 },
        );
        assert.deepStrictEqual(kernel.graph._edges, [pairHigh]);
        assert.strictEqual(kernel.graph._edges[0], pairHigh);
        assert.deepStrictEqual(calls.rebuild, [[]]);
        assert.deepStrictEqual(calls.save, [[]]);
        assert.equal(logged.length, 1);
        assert.match(String(logged[0][0]), /^\[Kernel\] Graph save/);
        assert.equal(logged[0][1], 'disk full');
      });
    } finally {
      console.error = originalConsoleError;
    }
  });
});

test('consolidate grouping is workspace-blind for pair and relation decisions', { concurrency: false }, () => {
  withKernel(kernel => {
    const crossWorkspacePairHigh = edge('shared-pair-from', 'shared-pair-to', 'kept', 0.9, {
      workspaceId: 'workspace-a',
    });
    const crossWorkspacePairLow = edge('shared-pair-from', 'shared-pair-to', 'stale', 0.2, {
      workspaceId: 'workspace-b',
    });
    const crossWorkspaceRelationHigh = edge('shared-rel-from', 'target-a', 'supports', 0.8, {
      workspaceId: 'workspace-a',
    });
    const crossWorkspaceRelationLow = edge('shared-rel-from', 'target-b', 'supports', 0.1, {
      workspaceId: 'workspace-b',
    });
    const originalEdges = [
      crossWorkspacePairHigh,
      crossWorkspacePairLow,
      crossWorkspaceRelationHigh,
      crossWorkspaceRelationLow,
    ];
    kernel.graph._edges = originalEdges;

    const result = kernel.consolidate(true);

    assert.deepStrictEqual(
      { dryRun: result.dryRun, removed: result.removed, detailCount: result.details.length },
      { dryRun: true, removed: 2, detailCount: 2 },
    );
    assertRemovalDetail(result.details[0], {
      from: 'shared-pair-from',
      to: 'shared-pair-to',
      relation: 'stale',
      weight: 0.2,
      fragments: ['low-weight (0.2)', 'high-weight (0.9)', 'same pair'],
    });
    assertRemovalDetail(result.details[1], {
      from: 'shared-rel-from',
      to: 'target-b',
      relation: 'supports',
      weight: 0.1,
      fragments: ['low-weight restriction (0.1)', "subject already has high-weight 'supports'"],
    });
    assert.strictEqual(kernel.graph._edges, originalEdges);
  });
});
