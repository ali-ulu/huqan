'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  RINGS,
  RULES,
  DEFAULT_DRIFT_THRESHOLD,
  assignLayer,
  isViolation,
  buildDependencySnapshot,
  checkDependencyGraph,
  driftCount,
} = require('../scripts/architecture-dependency-graph');
const {
  BASELINE_PATH,
  renderMarkdown,
} = require('../scripts/architecture-snapshot');

const CLI = path.resolve(__dirname, '../scripts/architecture-snapshot.js');

function graphObject(graph) {
  return new Map(Object.entries(graph));
}

test('every rule names a layer the ring order knows', () => {
  for (const rule of RULES) {
    assert.ok(RINGS.includes(rule.layer), `${rule.layer} is not one of ${RINGS.join(', ')}`);
    assert.ok(rule.why && rule.why.length > 20, `${rule.layer} needs a reason`);
  }
});

test('layer assignment is a path rule with no catch-all', () => {
  assert.equal(assignLayer('cli.js'), 'UI');
  assert.equal(assignLayer('lib/mcp/tool-dispatch.js'), 'UI');
  assert.equal(assignLayer('scripts/anything.js'), 'UI');
  assert.equal(assignLayer('storage.js'), 'Adapters');
  assert.equal(assignLayer('lib/memory-store.js'), 'Adapters');
  assert.equal(assignLayer('lib/connectors/mcp-connector.js'), 'Adapters');
  assert.equal(assignLayer('lib/receipt/canonical-receipt.js'), 'Application');
  assert.equal(assignLayer('plugins/daily-digest.js'), 'Application');
  assert.equal(assignLayer('kernel.js'), 'Core');
  assert.equal(assignLayer('lib/verify.js'), 'Core');

  // A directory or a root module no rule claims is unassigned, not Core: the
  // gate is supposed to stop and ask, not to absorb the new thing silently.
  assert.equal(assignLayer('lib/brand-new-area/thing.js'), null);
  assert.equal(assignLayer('newtop/thing.js'), null);
  assert.equal(assignLayer('new-root-module.js'), null);
});

test('an edge pointing outward is a violation, an inward edge is not', () => {
  assert.equal(isViolation('Core', 'UI'), true);
  assert.equal(isViolation('Core', 'Application'), true);
  assert.equal(isViolation('Core', 'Adapters'), true);
  assert.equal(isViolation('Application', 'UI'), true);
  assert.equal(isViolation('Adapters', 'Application'), true);
  assert.equal(isViolation('UI', 'Core'), false);
  assert.equal(isViolation('Application', 'Adapters'), false);
  assert.equal(isViolation('Adapters', 'Core'), false);
  assert.equal(isViolation('Core', 'Core'), false);
});

test('the snapshot keeps the graph, the rings and the violations apart', () => {
  const snapshot = buildDependencySnapshot(graphObject({
    'kernel.js': ['cli.js', 'storage.js', 'lib/verify.js'],
    'cli.js': ['kernel.js'],
    'storage.js': ['kernel.js'],
    'lib/verify.js': [],
    'lib/new-area/thing.js': ['kernel.js'],
  }));

  assert.deepEqual(snapshot.unassigned, ['lib/new-area/thing.js']);
  assert.equal(snapshot.layers['kernel.js'], 'Core');
  assert.equal(snapshot.layers['storage.js'], 'Adapters');
  // The unassigned module is reported, never guessed at: no edge of its own
  // and no edge into it is classified.
  assert.equal(snapshot.edges['lib/new-area/thing.js'], undefined);
  assert.deepEqual(snapshot.edges['cli.js'], ['kernel.js']);
  assert.deepEqual(
    snapshot.violations.map((edge) => `${edge.fromLayer} -> ${edge.toLayer}`),
    ['Core -> UI', 'Core -> Adapters'],
  );
});

test('drift counts shape changes, not rings that merely moved with a rule', () => {
  const current = buildDependencySnapshot(graphObject({
    'kernel.js': ['lib/verify.js'],
    'lib/verify.js': [],
  }));
  const baseline = { threshold: 10, layers: current.layers, edges: current.edges, violations: [] };
  assert.equal(driftCount(current, baseline), 0);

  const removed = buildDependencySnapshot(graphObject({ 'kernel.js': [], 'lib/verify.js': [] }));
  assert.equal(driftCount(removed, baseline), 1);

  const added = buildDependencySnapshot(graphObject({
    'kernel.js': ['lib/verify.js', 'storage.js'],
    'lib/verify.js': [],
    'storage.js': [],
  }));
  assert.equal(driftCount(added, baseline), 2);

  const reassigned = buildDependencySnapshot(graphObject({ 'lib/http/thing.js': [] }));
  assert.equal(driftCount(reassigned, {
    threshold: 10, layers: { 'lib/http/thing.js': 'Application' }, edges: {}, violations: [],
  }), 1);
});

test('a module with no ring fails the gate and names itself', () => {
  const current = buildDependencySnapshot(graphObject({ 'lib/new-area/thing.js': [] }));
  const result = checkDependencyGraph(current, { threshold: 10, layers: {}, edges: {}, violations: [] });
  assert.equal(result.ok, false);
  assert.ok(result.messages.some((message) => /FAIL unassigned/.test(message)));
  assert.ok(result.messages.some((message) => message.includes('lib/new-area/thing.js')));
  assert.equal(result.recorded, null);
});

test('a violation that is not recorded fails even with --update', () => {
  const current = buildDependencySnapshot(graphObject({
    'kernel.js': ['cli.js'],
    'cli.js': [],
    'storage.js': [],
  }));
  const baseline = {
    threshold: 10,
    layers: { 'kernel.js': 'Core', 'cli.js': 'UI', 'storage.js': 'Adapters' },
    edges: { 'kernel.js': [], 'cli.js': [], 'storage.js': [] },
    violations: [],
  };
  for (const argv of [[], ['--update'], ['--update-baseline']]) {
    const result = checkDependencyGraph(current, baseline, argv);
    assert.equal(result.ok, false, `expected a failure for ${argv.join(' ') || 'no flags'}`);
    assert.ok(result.messages.some((message) => /new layer violation/.test(message)));
    assert.equal(result.recorded, null);
  }
});

test('a recorded violation passes, and fixing it must be locked in deliberately', () => {
  const current = buildDependencySnapshot(graphObject({
    'kernel.js': ['cli.js'],
    'cli.js': [],
    'storage.js': [],
  }));
  const violation = { from: 'kernel.js', to: 'cli.js', fromLayer: 'Core', toLayer: 'UI' };
  const baseline = {
    threshold: 10,
    layers: { 'kernel.js': 'Core', 'cli.js': 'UI', 'storage.js': 'Adapters' },
    edges: { 'kernel.js': ['cli.js'], 'cli.js': [], 'storage.js': [] },
    violations: [violation],
  };
  assert.equal(checkDependencyGraph(current, baseline).ok, true);

  const fixed = buildDependencySnapshot(graphObject({
    'kernel.js': [],
    'cli.js': [],
    'storage.js': [],
  }));
  const failed = checkDependencyGraph(fixed, baseline);
  assert.equal(failed.ok, false);
  assert.ok(failed.messages.some((message) => /unrecorded gain/.test(message)));

  const updated = checkDependencyGraph(fixed, baseline, ['--update']);
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.recorded.violations, []);
});

test('a module that changes ring has to be re-recorded on purpose', () => {
  const current = buildDependencySnapshot(graphObject({ 'lib/http/thing.js': [] }));
  const baseline = { threshold: 10, layers: { 'lib/http/thing.js': 'Application' }, edges: {}, violations: [] };
  const failed = checkDependencyGraph(current, baseline);
  assert.equal(failed.ok, false);
  assert.ok(failed.messages.some((message) => /reassigned/.test(message)));
  assert.equal(checkDependencyGraph(current, baseline, ['--update']).ok, true);
});

test('drift above the threshold fails and the threshold is configurable', () => {
  // UI may require anything below it, so the extra edge is drift, not a violation.
  const current = buildDependencySnapshot(graphObject({
    'kernel.js': ['lib/verify.js'],
    'cli.js': ['lib/verify.js', 'storage.js'],
    'lib/verify.js': [],
    'storage.js': [],
  }));
  const baseline = {
    threshold: 0,
    layers: { 'kernel.js': 'Core', 'lib/verify.js': 'Core', 'storage.js': 'Adapters', 'cli.js': 'UI' },
    edges: { 'kernel.js': ['lib/verify.js'], 'cli.js': ['lib/verify.js'], 'lib/verify.js': [], 'storage.js': [] },
    violations: [],
  };
  const failed = checkDependencyGraph(current, baseline);
  assert.equal(failed.ok, false);
  assert.ok(failed.messages.some((message) => /FAIL drift: the module graph moved in 1 places/.test(message)));

  assert.equal(checkDependencyGraph(current, baseline, ['--drift-threshold=1']).ok, true);
  assert.equal(checkDependencyGraph(current, {}).threshold, DEFAULT_DRIFT_THRESHOLD);
});

test('a baseline may not record debt the base ref did not have', () => {
  const current = buildDependencySnapshot(graphObject({
    'kernel.js': ['cli.js'],
    'cli.js': [],
    'storage.js': [],
  }));
  const violation = { from: 'kernel.js', to: 'cli.js', fromLayer: 'Core', toLayer: 'UI' };
  const baseline = {
    threshold: 10,
    layers: { 'kernel.js': 'Core', 'cli.js': 'UI', 'storage.js': 'Adapters' },
    edges: { 'kernel.js': ['cli.js'], 'cli.js': [], 'storage.js': [] },
    violations: [violation],
  };
  const result = checkDependencyGraph(current, baseline, [], { threshold: 10, layers: {}, edges: {}, violations: [] });
  assert.equal(result.ok, false);
  assert.ok(result.messages.some((message) => /baseline cannot add debt/.test(message)));
});

/**
 * The CLI reads its whole world from files here: groups from --snapshot, the
 * graph from --graph-snapshot, both baselines from disk. Nothing in these tests
 * walks the live tree, which is what keeps them fast enough to run on every
 * push while still exercising the real command CI runs.
test('a baseline with no recorded graph fails instead of passing quietly', () => {
  const current = buildDependencySnapshot(graphObject({ 'kernel.js': [] }));
  const failed = checkDependencyGraph(current, null);
  assert.equal(failed.ok, false);
  assert.ok(failed.messages.some((message) => /carries no dependency graph/.test(message)));

  const seeded = checkDependencyGraph(current, null, ['--update']);
  assert.equal(seeded.ok, true);
  assert.equal(seeded.recorded.layers['kernel.js'], 'Core');
  assert.equal(seeded.recorded.threshold, DEFAULT_DRIFT_THRESHOLD);
});

/**
 * The CLI reads its whole world from files here: groups from --snapshot, the
 * graph from --graph-snapshot, both baselines from disk. Nothing in these tests
 * walks the live tree, which is what keeps them fast enough to run on every
 * push while still exercising the real command CI runs.
 */
function graphFixture(overrides = {}) {
  return {
    threshold: 10,
    layers: { 'kernel.js': 'Core', 'cli.js': 'UI', 'lib/verify.js': 'Core' },
    edges: { 'kernel.js': ['lib/verify.js'], 'lib/verify.js': [] },
    violations: [],
    unassigned: [],
    ...overrides,
  };
}

function fixtureCli(t, { dependency, baseline, previous }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-architecture-graph-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };
  const groups = { structural: [], recorded: [], decompose: [] };
  const paths = {
    tracker: write('tracker.md', renderMarkdown(groups)),
    snapshot: write('snapshot.json', groups),
    graph: write('graph.json', dependency),
    baseline: write('baseline.json', baseline ?? { schemaVersion: 3, entries: {}, dependencyGraph: graphFixture() }),
    previous: write('previous.json', previous ?? { schemaVersion: 3, entries: {}, dependencyGraph: graphFixture() }),
  };
  const run = (extra = []) => spawnSync(process.execPath, [
    CLI,
    `--check=${paths.tracker}`,
    `--baseline=${paths.baseline}`,
    `--previous-baseline=${paths.previous}`,
    `--snapshot=${paths.snapshot}`,
    `--graph-snapshot=${paths.graph}`,
    ...extra,
  ], { encoding: 'utf8' });
  return { run, paths };
}

test('the real CLI passes when the live graph matches the recorded one', (t) => {
  const { run } = fixtureCli(t, { dependency: graphFixture() });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matches the live snapshot/);
});

test('the real CLI fails on a violation that is not recorded', (t) => {
  const { run } = fixtureCli(t, {
    dependency: graphFixture({
      edges: { 'kernel.js': ['cli.js'], 'cli.js': [] },
      layers: { 'kernel.js': 'Core', 'cli.js': 'UI' },
      violations: [{ from: 'kernel.js', to: 'cli.js', fromLayer: 'Core', toLayer: 'UI' }],
    }),
    baseline: { schemaVersion: 3, entries: {}, dependencyGraph: graphFixture({ layers: { 'kernel.js': 'Core', 'cli.js': 'UI' } }) },
  });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new layer violation/);
  assert.match(result.stderr, /kernel\.js \(Core\) -> cli\.js \(UI\)/);
});

test('the real CLI fails on a module that matches no ring', (t) => {
  const { run } = fixtureCli(t, {
    dependency: graphFixture({ unassigned: ['lib/new-area/thing.js'] }),
  });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL unassigned/);
  assert.match(result.stderr, /lib\/new-area\/thing\.js/);
});

test('the real CLI fails when the graph drifts past the recorded threshold', (t) => {
  const { run } = fixtureCli(t, {
    dependency: graphFixture({ edges: { 'kernel.js': ['lib/verify.js', 'cli.js'], 'cli.js': [], 'lib/verify.js': [] } }),
    baseline: {
      schemaVersion: 3,
      entries: {},
      dependencyGraph: graphFixture({ threshold: 0, layers: { 'kernel.js': 'Core', 'lib/verify.js': 'Core', 'cli.js': 'UI' } }),
    },
  });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL drift: the module graph moved in 1 places, over the recorded threshold of 0/);
});

test('--update cannot record a new violation, and can lock in a fixed one', (t) => {
  const violation = { from: 'kernel.js', to: 'cli.js', fromLayer: 'Core', toLayer: 'UI' };
  const clean = graphFixture({
    layers: { 'kernel.js': 'Core', 'cli.js': 'UI' },
    edges: { 'kernel.js': [], 'cli.js': [] },
  });
  const crossed = graphFixture({
    layers: { 'kernel.js': 'Core', 'cli.js': 'UI' },
    edges: { 'kernel.js': ['cli.js'], 'cli.js': [] },
    violations: [violation],
  });

  const seeded = fixtureCli(t, {
    dependency: crossed,
    baseline: { schemaVersion: 3, entries: {}, dependencyGraph: clean },
    previous: { schemaVersion: 3, entries: {}, dependencyGraph: clean },
  });
  const refused = seeded.run(['--update']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /new layer violation/);
  assert.deepEqual(JSON.parse(fs.readFileSync(seeded.paths.baseline, 'utf8')).dependencyGraph.violations, []);

  const paid = fixtureCli(t, {
    dependency: clean,
    baseline: { schemaVersion: 3, entries: {}, dependencyGraph: crossed },
    previous: { schemaVersion: 3, entries: {}, dependencyGraph: crossed },
  });

  assert.equal(paid.run().status, 1);
  assert.match(paid.run().stderr, /unrecorded gain/);
  const locked = paid.run(['--update']);
  assert.equal(locked.status, 0, locked.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(paid.paths.baseline, 'utf8')).dependencyGraph.violations, []);
});

test('the committed baseline describes a graph the ring order can read', () => {
  const artifact = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.equal(artifact.schemaVersion, 3);
  const graph = artifact.dependencyGraph;
  assert.ok(graph, 'the artifact must carry the #2641 dependency graph');
  assert.ok(Number.isInteger(graph.threshold) && graph.threshold > 0, 'the drift threshold is configurable, not absent');

  for (const [file, layer] of Object.entries(graph.layers)) {
    assert.ok(RINGS.includes(layer), `${file} has layer ${layer}`);
  }
  for (const edge of graph.violations) {
    assert.ok(graph.layers[edge.from] && graph.layers[edge.to], `${edge.from} -> ${edge.to} is not assigned`);
    assert.equal(edge.fromLayer, graph.layers[edge.from]);
    assert.equal(edge.toLayer, graph.layers[edge.to]);
    assert.equal(isViolation(edge.fromLayer, edge.toLayer), true, `${edge.from} -> ${edge.to} is not a violation`);
    assert.ok((graph.edges[edge.from] || []).includes(edge.to), `${edge.from} -> ${edge.to} is not a recorded edge`);
  }
});
