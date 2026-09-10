'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');

// A negated statement can conflict with two different edge families, and they
// are not interchangeable: a fact edge (`yapabilir`, `özellik`) and a type edge
// (`tür`). #1989 added the type half; #2065 implemented it by widening
// _collectFactTargets to swallow type relations, which broke #734's
// workspace-isolation contract. The split now lives in
// lib/kernel-v2-type-negation.js.
//
// A mutation sweep over all 32 test files that touch kernel.v2 found that
// killing the fact branch turned nothing red -- it was carried entirely by
// construction. These tests pin both branches so neither can be dropped or
// merged back silently.

function withKernel(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-negation-families-'));
  try {
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      useSQLite: false,
      memoryPath: path.join(dir, 'memory.json'),
      lang: 'tr',
    });
    kernel._autoMaintain = () => {};
    kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
    kernel._learnCount = 0;
    run(kernel);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a negated statement contradicts a known fact edge', () => {
  withKernel((kernel) => {
    kernel.graph.addNode('ali', 'ali');
    kernel.graph.addNode('doktor', 'doktor');
    kernel.graph.addEdge('ali', 'doktor', 'yapabilir', { confidence: 0.9, weight: 0.85 });

    const result = new KernelV2({ kernel }).verify('Ali doktor değildir', { workspaceId: 'default' });

    assert.equal(result.data.status, 'contradicted');
    assert.equal(result.data.contradictionReason, 'negated_statement_conflicts_with_known_fact');
    assert.equal(result.data.confidence, 0.85);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, 'direct_edge');
    assert.match(result.evidence[0].text, /yapabilir/);
  });
});

test('a negated statement contradicts a known type edge (#1989)', () => {
  withKernel((kernel) => {
    kernel.graph.addNode('ali', 'ali');
    kernel.graph.addNode('doktor', 'doktor');
    kernel.graph.addEdge('ali', 'doktor', 'tür', { confidence: 0.9, weight: 0.9 });

    const result = new KernelV2({ kernel }).verify('Ali doktor değildir', { workspaceId: 'default' });

    assert.equal(result.data.status, 'contradicted');
    assert.equal(result.data.contradictionReason, 'negated_statement_conflicts_with_known_fact');
    assert.equal(result.evidence.length, 1);
    assert.match(result.evidence[0].text, /tür/);
  });
});

// The regression #2065 introduced, stated as a rule rather than as one
// workspace assertion: the fact collector must not report type edges.
test('_collectFactTargets reports fact edges only, never type edges', () => {
  withKernel((kernel) => {
    kernel.graph.addNode('kedi', 'kedi');
    kernel.graph.addNode('hayvan', 'hayvan');
    kernel.graph.addNode('ucar', 'ucar');
    kernel.graph.addEdge('kedi', 'hayvan', 'tür', { confidence: 0.9, weight: 0.9 });
    kernel.graph.addEdge('kedi', 'ucar', 'yapabilir', { confidence: 0.9, weight: 0.9 });

    const v2 = new KernelV2({ kernel });

    assert.deepStrictEqual(
      v2._collectFactTargets('kedi', 'default').map((f) => f.rawTarget),
      ['ucar'],
    );
    assert.deepStrictEqual(v2._collectTypeTargets('kedi', 'default'), ['hayvan']);

    const factEvidence = v2._buildDirectFactEvidence('kedi', 'default').map((e) => e.text).join(' | ');
    assert.ok(!factEvidence.includes('hayvan'), `fact evidence leaked a type edge: ${factEvidence}`);
  });
});
