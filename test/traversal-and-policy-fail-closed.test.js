const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');
const Kernel = require('../kernel');
const {
  CYCLE_DEFAULT_MAX_DEPTH,
  CYCLE_STOPPED,
  detectCycle,
  detectCycleBounded,
} = require('../lib/graph-traversal');
const {
  TRUST_POLICY_UNAVAILABLE_CONFIDENCE,
  admissionRiskFromConfidence,
  buildBackgroundProvenance,
} = require('../lib/background-provenance');

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-failclosed-'));
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function chainGraph(length, { closeCycle = false } = {}) {
  const graph = new Graph({ useSQLite: false, noLoad: true });
  for (let i = 0; i < length; i++) graph.addNode(`n${i}`, `n${i}`, null, { workspaceId: 'default' });
  for (let i = 0; i < length - 1; i++) {
    graph.addEdge(`n${i}`, `n${i + 1}`, 'tür', { workspaceId: 'default' });
  }
  if (closeCycle) graph.addEdge(`n${length - 1}`, 'n0', 'tür', { workspaceId: 'default' });
  return graph;
}

describe('cycle detection is bounded, not recursive (#743)', () => {
  it('a chain far deeper than the JS stack terminates without RangeError', () => {
    const graph = chainGraph(20_000);
    const result = detectCycleBounded(graph, 'n0');
    assert.strictEqual(result.cycle, null);
    assert.strictEqual(result.stoppedReason, CYCLE_STOPPED.MAX_DEPTH);
    assert.ok(result.visitedCount <= CYCLE_DEFAULT_MAX_DEPTH);
  });

  it('a deep cycle terminates too', () => {
    const graph = chainGraph(20_000, { closeCycle: true });
    assert.doesNotThrow(() => detectCycleBounded(graph, 'n0'));
  });

  it('short-cycle semantics are unchanged', () => {
    const graph = new Graph({ useSQLite: false, noLoad: true });
    for (const id of ['a', 'b', 'c']) graph.addNode(id, id, null, { workspaceId: 'default' });
    graph.addEdge('a', 'b', 'tür', { workspaceId: 'default' });
    graph.addEdge('b', 'c', 'tür', { workspaceId: 'default' });
    graph.addEdge('c', 'a', 'tür', { workspaceId: 'default' });

    assert.deepStrictEqual(detectCycle(graph, 'a', new Set(), [], 'default'), ['a', 'b', 'c', 'a']);
    const bounded = detectCycleBounded(graph, 'a');
    assert.deepStrictEqual(bounded.cycle, ['a', 'b', 'c', 'a']);
    assert.strictEqual(bounded.stoppedReason, CYCLE_STOPPED.COMPLETE);
  });

  it('an acyclic graph within budget still reports no cycle and no stop', () => {
    const graph = chainGraph(10);
    const result = detectCycleBounded(graph, 'n0');
    assert.strictEqual(result.cycle, null);
    assert.strictEqual(result.stoppedReason, CYCLE_STOPPED.COMPLETE);
  });

  it('budgets are individually enforceable', () => {
    const graph = chainGraph(500);
    assert.strictEqual(detectCycleBounded(graph, 'n0', { maxDepth: 10 }).stoppedReason, CYCLE_STOPPED.MAX_DEPTH);
    assert.strictEqual(detectCycleBounded(graph, 'n0', { maxNodes: 5 }).stoppedReason, CYCLE_STOPPED.MAX_NODES);
    assert.strictEqual(detectCycleBounded(graph, 'n0', { timeoutMs: 0.0001 }).stoppedReason, CYCLE_STOPPED.TIMEOUT);
  });

  it('a shallow cycle is still found when a deep branch hits the depth budget', () => {
    const graph = chainGraph(2000);
    // A short cycle hanging off the start node, reachable before the long chain
    // exhausts the depth budget.
    for (const id of ['x', 'y']) graph.addNode(id, id, null, { workspaceId: 'default' });
    graph.addEdge('n0', 'x', 'tür', { workspaceId: 'default' });
    graph.addEdge('x', 'y', 'tür', { workspaceId: 'default' });
    graph.addEdge('y', 'n0', 'tür', { workspaceId: 'default' });

    const result = detectCycleBounded(graph, 'n0', { maxDepth: 50 });
    assert.ok(result.cycle, 'a cycle within budget must still be reported');
    assert.ok(result.cycle.includes('x') && result.cycle.includes('y'));
  });

  it('a "neden" question over a deep chain does not crash the kernel', () => {
    const kernel = new Kernel({
      memoryPath: path.join(tempDir, 'reason.json'),
      useSQLite: false,
      noLoad: true,
      loadPlugins: false,
    });
    const graph = kernel.graph;
    const N = 15_000;
    for (let i = 0; i < N; i++) graph.addNode(`n${i}`, `n${i}`, null, { workspaceId: 'default' });
    for (let i = 0; i < N - 1; i++) graph.addEdge(`n${i}`, `n${i + 1}`, 'tür', { workspaceId: 'default' });

    let result;
    assert.doesNotThrow(() => { result = kernel.ask('neden n0'); }, 'ask/reason must not throw on a deep chain');
    assert.ok(result);
  });
});

describe('trust policy failure does not lower admission risk (#741)', () => {
  function policyPath(name, contents) {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, contents);
    return file;
  }

  const failures = [
    ['missing file', () => path.join(tempDir, 'absent-policy.json')],
    ['malformed JSON', () => policyPath('malformed.json', '{ not json at all')],
    ['wrong top-level shape', () => policyPath('wrong-shape.json', '[1,2,3]')],
    ['empty file', () => policyPath('empty.json', '')],
  ];

  for (const [label, makePath] of failures) {
    it(`${label}: risk is not lowered`, () => {
      const provenance = buildBackgroundProvenance('selftest', 'w', {}, { trustPolicyPath: makePath() });
      assert.strictEqual(provenance.trustPolicyStatus, 'unavailable');
      assert.ok(
        provenance.confidence <= TRUST_POLICY_UNAVAILABLE_CONFIDENCE,
        `confidence ${provenance.confidence} above the failure floor`,
      );
      assert.ok(admissionRiskFromConfidence(provenance.confidence) > 0,
        'a policy failure must not produce risk 0');
    });
  }

  it('policy failure is never more permissive than a working policy', () => {
    const working = buildBackgroundProvenance('selftest', 'w', {}, {});
    const broken = buildBackgroundProvenance('selftest', 'w', {}, {
      trustPolicyPath: path.join(tempDir, 'absent-policy.json'),
    });
    assert.ok(
      admissionRiskFromConfidence(broken.confidence) >= admissionRiskFromConfidence(working.confidence),
      'a broken policy scored lower risk than a working one',
    );
  });

  it('a caller-supplied confidence cannot survive the failure', () => {
    const provenance = buildBackgroundProvenance('selftest', 'w', { confidence: 0.99 }, {
      trustPolicyPath: path.join(tempDir, 'absent-policy.json'),
    });
    assert.strictEqual(provenance.confidence, TRUST_POLICY_UNAVAILABLE_CONFIDENCE);
    assert.ok(admissionRiskFromConfidence(provenance.confidence) > 0);
  });

  it('the failure reason is stable and leaks no filesystem detail', () => {
    const secretPath = path.join(tempDir, 'super-secret-policy-location.json');
    const provenance = buildBackgroundProvenance('selftest', 'w', {}, { trustPolicyPath: secretPath });
    const serialized = JSON.stringify(provenance);
    assert.strictEqual(provenance.trustPolicyStatus, 'unavailable');
    assert.strictEqual(provenance.confidenceSource, 'trust_policy_unavailable');
    assert.ok(!serialized.includes('super-secret-policy-location'),
      `provenance leaked the policy path: ${serialized}`);
  });

  it('a valid policy still scores the background source normally', () => {
    const provenance = buildBackgroundProvenance('selftest', 'w', {}, {});
    assert.strictEqual(provenance.sourceType, 'background_inference');
    assert.strictEqual(provenance.confidence, 0.3);
    assert.strictEqual(provenance.trustPolicyStatus, undefined);
  });
});
