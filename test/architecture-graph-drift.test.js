'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { RANK } = require('../scripts/check-layers');
const {
  buildArchitectureGraphSnapshot,
  graphBaselineMatches,
  graphChurn,
  graphEvolutionViolations,
} = require('../scripts/architecture-graph-snapshot');

test('live architecture graph assigns every module to a canonical layer and has no unapproved violations', () => {
  const snapshot = buildArchitectureGraphSnapshot();
  const knownLayers = new Set(Object.keys(RANK));

  assert.ok(Object.keys(snapshot.modules).length > 0);
  assert.ok(snapshot.edges.length > 0);
  for (const [file, layer] of Object.entries(snapshot.modules)) {
    assert.ok(knownLayers.has(layer), `${file} has non-canonical layer ${layer}`);
  }
  assert.deepEqual(snapshot.violations, []);
});

test('graph snapshots compare deterministically', () => {
  const snapshot = {
    schemaVersion: 1,
    modules: { 'a.js': 'domain' },
    edges: [],
    violations: [],
  };
  assert.equal(graphBaselineMatches(snapshot, structuredClone(snapshot)), true);
  assert.equal(graphBaselineMatches(snapshot, { ...snapshot, modules: { 'a.js': 'storage' } }), false);
});

test('graph churn counts module-layer and dependency-edge changes', () => {
  const previous = {
    modules: { 'a.js': 'domain', 'b.js': 'shared' },
    edges: [{ from: 'a.js', to: 'b.js' }],
  };
  const current = {
    modules: { 'a.js': 'storage', 'b.js': 'shared', 'c.js': 'shared' },
    edges: [
      { from: 'a.js', to: 'b.js' },
      { from: 'a.js', to: 'c.js' },
    ],
  };

  const churn = graphChurn(previous, current);
  assert.equal(churn.moduleChanges, 2);
  assert.equal(churn.edgeChanges, 1);
  assert.equal(churn.ratio, 1);
});

test('bounded graph evolution passes while excessive churn fails closed', () => {
  const previous = {
    modules: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`m${index}.js`, 'domain'])),
    edges: Array.from({ length: 20 }, (_, index) => ({
      from: `m${index}.js`,
      to: `leaf${index}.js`,
      fromLayer: 'domain',
      toLayer: 'shared',
    })),
    violations: [],
  };
  const bounded = structuredClone(previous);
  bounded.edges.push({
    from: 'm0.js',
    to: 'leaf-extra.js',
    fromLayer: 'domain',
    toLayer: 'shared',
  });
  const excessive = structuredClone(previous);
  excessive.modules['new-a.js'] = 'domain';
  excessive.modules['new-b.js'] = 'domain';
  excessive.modules['new-c.js'] = 'domain';
  excessive.edges.push(
    { from: 'new-a.js', to: 'leaf-a.js', fromLayer: 'domain', toLayer: 'shared' },
    { from: 'new-b.js', to: 'leaf-b.js', fromLayer: 'domain', toLayer: 'shared' },
    { from: 'new-c.js', to: 'leaf-c.js', fromLayer: 'domain', toLayer: 'shared' },
  );

  assert.deepEqual(graphEvolutionViolations(previous, bounded, { maxGraphChurnRatio: 0.2 }), []);
  assert.match(
    graphEvolutionViolations(previous, excessive, { maxGraphChurnRatio: 0.1 })[0],
    /architecture graph churn/,
  );
});

test('layer violations and unknown assignments are explicit graph failures', () => {
  const bad = {
    modules: { 'a.js': 'mystery', 'b.js': 'entrypoint' },
    edges: [],
    violations: [{
      from: 'a.js',
      to: 'b.js',
      fromLayer: 'domain',
      toLayer: 'entrypoint',
    }],
  };
  const violations = graphEvolutionViolations(null, bad, { maxGraphChurnRatio: 1 });
  assert.ok(violations.some((item) => item.includes('unknown architecture layer')));
  assert.ok(violations.some((item) => item.includes('layer violation')));
});
