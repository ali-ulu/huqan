'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDependencyGraph, dreamDependencyCandidates, selectCandidate } = require('../lib/self-healer/source-dependency-graph');
const { simulateInSandbox, buildFinding, simulateSourceCandidate } = require('../lib/self-healer/source-dogfood-simulator');
const { decideSelfHealerAction } = require('../lib/self-healer/safety-decision');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-sh-source-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('source dogfood builds a bounded transitive dependency graph', () => {
  const root = fixture({ 'entry.js': "module.exports = require('./middle');\n", 'middle.js': "module.exports = require('./leaf');\n", 'leaf.js': 'module.exports = 1;\n' });
  try {
    const graph = buildDependencyGraph({ root, targetPath: 'entry.js' });
    assert.deepEqual(graph.nodes, ['entry.js', 'leaf.js', 'middle.js']);
    assert.deepEqual(graph.edges, [{ from: 'entry.js', to: 'middle.js' }, { from: 'middle.js', to: 'leaf.js' }]);
  } finally { cleanup(root); }
});

test('source dogfood ignores require text inside comments and string literals', () => {
  const root = fixture({
    'entry.js': [
      '// require(\'./legacy\')',
      'const documentation = "do not call require(\\\'./secret-config\\\')";',
      '/* require(\'./commented-out\') */',
      'const template = `require(\'./template\')`;',
      "module.exports = require('./real');",
    ].join('\n'),
    'real.js': 'module.exports = 1;\n',
    'legacy.js': 'module.exports = 2;\n',
    'secret-config.js': 'module.exports = 3;\n',
    'commented-out.js': 'module.exports = 4;\n',
    'template.js': 'module.exports = 5;\n',
  });
  try {
    const graph = buildDependencyGraph({ root, targetPath: 'entry.js' });
    assert.deepEqual(graph.nodes, ['entry.js', 'real.js']);
    assert.deepEqual(graph.edges, [{ from: 'entry.js', to: 'real.js' }]);
    assert.equal(graph.truncated, false);
  } finally { cleanup(root); }
});

test('source dogfood returns a bounded partial graph instead of throwing at maxFiles', () => {
  const root = fixture({
    'entry.js': "module.exports = [require('./a'), require('./b')];\n",
    'a.js': "module.exports = require('./leaf-a');\n",
    'b.js': "module.exports = require('./leaf-b');\n",
    'leaf-a.js': 'module.exports = 1;\n',
    'leaf-b.js': 'module.exports = 2;\n',
  });
  try {
    const graph = buildDependencyGraph({ root, targetPath: 'entry.js', maxFiles: 2 });
    assert.deepEqual(graph.nodes, ['a.js', 'entry.js']);
    assert.deepEqual(graph.edges, [{ from: 'entry.js', to: 'a.js' }]);
    assert.equal(graph.truncated, true);
    assert.equal(graph.maxFiles, 2);
  } finally { cleanup(root); }
});

test('Dream turns a source-derived transitive path into a review candidate', () => {
  const root = fixture({ 'entry.js': "module.exports = require('./middle');\n", 'middle.js': "module.exports = require('./leaf');\n", 'leaf.js': 'module.exports = 1;\n' });
  try {
    const graph = buildDependencyGraph({ root, targetPath: 'entry.js' });
    const candidate = selectCandidate(graph, dreamDependencyCandidates(graph));
    assert.ok(candidate);
    assert.equal(candidate.from, 'entry.js');
    assert.equal(candidate.to, 'leaf.js');
    assert.equal(candidate.hypothesisType, 'zincir');
    assert.equal(candidate.applied, false);
    assert.equal(candidate.patchIncluded, false);
  } finally { cleanup(root); }
});

test('sandbox simulation stays data-only and reports whether an edge closes a cycle', () => {
  const graph = { nodes: ['entry.js', 'middle.js', 'leaf.js'], edges: [{ from: 'entry.js', to: 'middle.js' }, { from: 'middle.js', to: 'leaf.js' }, { from: 'leaf.js', to: 'entry.js' }] };
  const result = simulateInSandbox(graph, { from: 'entry.js', to: 'leaf.js' });
  assert.equal(result.ok, true);
  assert.equal(result.closesCycle, true);
  assert.equal(result.beforeEdges, 3);
  assert.equal(result.afterEdges, 4);
});

test('full source simulation compares graph structure and emits a review-only finding', async () => {
  const root = fixture({ 'entry.js': "module.exports = require('./middle');\n", 'middle.js': "module.exports = require('./leaf');\n", 'leaf.js': 'module.exports = 1;\n' });
  try {
    const result = await simulateSourceCandidate({ root, targetPath: 'entry.js', workspaceId: 'default' });
    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.equal(result.patchIncluded, false);
    assert.equal(result.candidate.from, 'entry.js');
    assert.equal(result.candidate.to, 'leaf.js');
    assert.equal(result.sandbox.closesCycle, false);
    assert.equal(result.rustComparison.after.edges, result.rustComparison.before.edges + 1);
    assert.ok(['review', 'dry_run_only'].includes(result.codeChangeGate.decision));
    assert.deepEqual(result.finding.riskFlags, ['runtime_mutation', 'dependency_setup']);
    assert.equal(result.finding.suggestedFix.allowedFiles[0], 'entry.js');
    assert.match(result.finding.summary, /No patch was generated or applied/);
  } finally { cleanup(root); }
});

test('truncated dependency evidence stays medium risk and capped confidence', () => {
  const candidate = { candidateId: 'shc_truncated', from: 'entry.js', to: 'leaf.js', hypothesisType: 'zincir', confidence: 0.9 };
  const finding = buildFinding(
    candidate,
    { closesCycle: true, beforeEdges: 2, afterEdges: 3 },
    { backend: 'js-fallback', before: { edges: 2 }, after: { edges: 3 } },
    { decision: 'review', reason: 'RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN' },
    { truncated: true, maxFiles: 2 },
  );
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.confidence, 0.5);
  assert.equal(finding.riskFlags.includes('dependency_graph_truncated'), true);
  assert.match(finding.summary, /incomplete evidence/);
});

test('a code-change gate block cannot be downgraded into a review approval', () => {
  const candidate = { candidateId: 'shc_blocked', from: 'secret-release.js', to: 'helper.js', hypothesisType: 'zincir', confidence: 0.8 };
  const finding = buildFinding(candidate, { closesCycle: false, beforeEdges: 1, afterEdges: 2 }, { backend: 'js-fallback', before: { edges: 1 }, after: { edges: 2 } }, { decision: 'block', reason: 'SECRET_CHANGE_BLOCKED' });
  assert.equal(finding.riskFlags.includes('code_change_gate_block'), true);
  const decision = decideSelfHealerAction(finding);
  assert.equal(decision.decision, 'block');
  assert.equal(decision.requiresApproval, false);
});

test('source simulation returns no candidate when there is no structural hypothesis', async () => {
  const root = fixture({ 'entry.js': 'module.exports = 1;\n' });
  try {
    const result = await simulateSourceCandidate({ root, targetPath: 'entry.js' });
    assert.equal(result.ok, true);
    assert.equal(result.candidate, null);
    assert.equal(result.applied, false);
  } finally { cleanup(root); }
});

test('source graph fails closed when target escapes root', () => {
  const root = fixture({ 'entry.js': 'module.exports = 1;\n' });
  try {
    assert.throws(() => buildDependencyGraph({ root, targetPath: '../outside.js' }), (error) => error && error.code === 'SELF_HEALER_TARGET_OUTSIDE_ROOT');
  } finally { cleanup(root); }
});

test('source graph enforces per-file byte bounds before reading', () => {
  const root = fixture({ 'entry.js': 'x'.repeat(64) });
  try {
    assert.throws(() => buildDependencyGraph({ root, targetPath: 'entry.js', maxFileBytes: 16 }), (error) => error && error.code === 'SELF_HEALER_SOURCE_TOO_LARGE');
  } finally { cleanup(root); }
});
