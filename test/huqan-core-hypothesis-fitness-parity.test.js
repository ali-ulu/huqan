'use strict';

/**
 * Result parity between the JavaScript hypothesis/fitness engines and their
 * Rust port in `huqan-core`.
 *
 * `docs/task-packs/rust-integration-source-reality.md` records the decision
 * `RUST_DEFERRED` and lists what a future Rust integration gate must prove.
 * Item 3 of that list is "exact result and error parity for one bounded
 * operation". This test is that proof for two bounded, read-only operations —
 * and only that. It does not wire Rust into the Kernel, does not claim a
 * performance result, and does not make the Rust path authoritative.
 *
 * ## Why these two operations
 *
 * They are pure functions of the graph: they read, they never write, and they
 * take no clock and no identity. A second implementation of a read is
 * checkable; a second implementation of a write would have to prove receipt,
 * admission and audit parity too, which is a much larger claim.
 *
 * ## What "parity" means here
 *
 * Deep equality of the emitted report, plus identical ordering of the
 * hypothesis sequence. Key order inside a JSON object is deliberately NOT
 * asserted: serde_json serializes object keys alphabetically while JavaScript
 * emits them in insertion order, and JSON objects are unordered by definition.
 * Every value, and the order of every array, must match.
 *
 * ## Skip behaviour
 *
 * The release binary is not tracked (see the task-pack's build boundary), so
 * these cases skip when it is absent rather than failing. A skip here is not a
 * parity proof — it is the absence of one.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { generateHypotheses } = require('../lib/graph-hypotheses');
const { buildFitnessReport } = require('../lib/hypothesis-fitness');

const ROOT = path.join(__dirname, '..');
const BIN_CANDIDATES = [
  path.join(ROOT, 'huqan-core', 'target', 'release', process.platform === 'win32' ? 'huqan-core.exe' : 'huqan-core'),
  path.join(ROOT, 'huqan-core', 'target', 'x86_64-pc-windows-gnu', 'release', 'huqan-core.exe'),
];
const BIN = BIN_CANDIDATES.find(candidate => fs.existsSync(candidate));
const skip = BIN ? false : 'huqan-core release binary not built';

function rustExec(commands) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`huqan-core exit ${code}: ${stderr}`));
      resolve(stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    });
    proc.stdin.end(commands.map(command => JSON.stringify(command)).join('\n'));
  });
}

/**
 * The binary answers one JSON line per command, and a reply *is* the report
 * with an `ok` flag alongside it rather than a report nested under a key.
 * Stripping `ok` leaves exactly the object the JavaScript function returns, so
 * the two can be deep-compared without reshaping either side.
 */
function reportFrom(replies) {
  const { ok, ...report } = replies.at(-1);
  assert.equal(ok, true, 'the rust command must report success');
  return report;
}

/**
 * One fixture that fires every rule at once.
 *
 * A graph that triggers only some rules would let a whole rule diverge without
 * the test noticing, so this deliberately contains: a causal cycle
 * (alpha→beta→gamma→alpha), a node whose only incoming edge carries no
 * evidence (gamma), a node at exactly the critical in-degree (beta), edges
 * below the confidence floor, an evidence array holding only a blank string
 * (which must NOT count as evidence), a fully isolated node, and a small
 * component detached from the main body.
 */
const NODES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'lonely', 'p', 'q'];
const EDGES = [
  { from: 'alpha', to: 'beta', relation: 'CAUSES', confidence: 0.9, evidence: ['e1'], strength: 0.8 },
  { from: 'beta', to: 'gamma', relation: 'CAUSES', confidence: 0.8, evidence: [], strength: 0.8 },
  { from: 'gamma', to: 'alpha', relation: 'LEADS_TO', confidence: 0.7, evidence: ['e2'], strength: 0.8 },
  { from: 'delta', to: 'beta', relation: 'related_to', confidence: 0.2, evidence: [] },
  { from: 'epsilon', to: 'beta', relation: 'is_a', confidence: 0.95, evidence: ['e3'] },
  { from: 'zeta', to: 'beta', relation: 'has_property', confidence: 0.15, evidence: [''] },
  { from: 'alpha', to: 'beta', relation: 'is_a', confidence: 0.3, evidence: [] },
  { from: 'p', to: 'q', relation: 'related_to', confidence: 0.5, evidence: ['e4'] },
];

function buildJsGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-core-parity-'));
  const graph = new Graph({ memoryPath: path.join(dir, 'memory.json') });
  for (const id of NODES) graph.addNode(id, id, { workspaceId: 'default' });
  for (const edge of EDGES) {
    graph.addEdge(edge.from, edge.to, edge.relation, {
      workspaceId: 'default',
      confidence: edge.confidence,
      evidence: edge.evidence,
      ...(edge.strength === undefined ? {} : { strength: edge.strength }),
    });
  }
  return graph;
}

function seedCommands() {
  return [
    ...NODES.map(id => ({ cmd: 'add_node', id, label: id, workspaceId: 'default' })),
    ...EDGES.map(edge => ({
      cmd: 'add_edge',
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      workspaceId: 'default',
      confidence: edge.confidence,
      evidence: edge.evidence,
    })),
  ];
}

/**
 * `provenance.sourceType` is what makes a candidate a hypothesis candidate on
 * the JavaScript side (lib/hypothesis-review.js#HYPOTHESIS_SOURCE_TYPE). The
 * Rust store carries the same value as a flat `sourceType` on `add_candidate`.
 * One contract, two encodings — so the fixture is written once and translated.
 */
function hypothesisCandidate(claim, status) {
  return { claim, status, workspaceId: 'default', provenance: { sourceType: 'hypothesis-engine' } };
}

/**
 * A kernel stub that scopes candidates by workspace, the way the real kernel
 * does. `buildFeedbackStats` passes `{ workspaceId }` down and trusts the
 * kernel to honour it; the Rust side filters in `all_candidates`. A stub that
 * ignored the argument would hide a scoping divergence instead of catching it.
 */
function kernelWith(graph, candidates) {
  return {
    graph,
    getCandidateClaims: ({ workspaceId = 'default' } = {}) =>
      candidates.filter(candidate => candidate.workspaceId === workspaceId),
  };
}

function candidateCommands(candidates) {
  return candidates.map(candidate => ({
    cmd: 'add_candidate',
    claim: candidate.claim,
    status: candidate.status,
    sourceType: candidate.provenance.sourceType,
    workspaceId: candidate.workspaceId,
  }));
}

const REVIEW_HISTORY = [
  hypothesisCandidate('[KANIT_EKSİK] a', 'accepted'),
  hypothesisCandidate('[ZAYIF_BAĞ] b', 'accepted'),
  hypothesisCandidate('[ZAYIF_BAĞ] c', 'rejected'),
  hypothesisCandidate('[KRİTİK_DÜĞÜM] d', 'pending'),
];

describe('huqan-core parity: hypothesis engine', { skip }, () => {
  it('produces the same report as lib/graph-hypotheses.js', async () => {
    const graph = buildJsGraph();
    const expected = generateHypotheses(graph, { workspaceId: 'default' });
    const replies = await rustExec([...seedCommands(), { cmd: 'hypotheses', workspaceId: 'default' }]);
    const actual = reportFrom(replies);

    // Guard against a vacuous pass: an engine that returned nothing would
    // deep-equal an engine that returned nothing.
    assert.equal(expected.hypotheses.length, 8, 'fixture must fire every rule');
    assert.deepEqual(Object.keys(expected.meta.ruleCounts).sort(), [
      'KANIT_EKSİK', 'KRİTİK_DÜĞÜM', 'KÜÇÜK_BİLEŞEN',
      'NEDENSEL_DÖNGÜ', 'YALITILMIŞ_DÜĞÜM', 'ZAYIF_BAĞ',
    ]);

    assert.deepEqual(actual.meta, expected.meta);
    assert.deepEqual(actual.hypotheses, expected.hypotheses);
  });

  it('emits the hypotheses in the same order, not merely the same set', async () => {
    const graph = buildJsGraph();
    const expected = generateHypotheses(graph, { workspaceId: 'default' });
    const replies = await rustExec([...seedCommands(), { cmd: 'hypotheses', workspaceId: 'default' }]);
    const actual = reportFrom(replies);

    const sequence = report => report.map(h => `${h.severity}|${h.type}|${h.target}`);
    assert.deepEqual(sequence(actual.hypotheses), sequence(expected.hypotheses));
  });

  it('applies the same option bounds, falling back rather than clamping', async () => {
    const graph = buildJsGraph();
    // criticalInDegree 0 is below the minimum and smallComponentSize 1.5 is
    // not an integer: both must fall back to the defaults in both engines.
    const options = { workspaceId: 'default', criticalInDegree: 0, smallComponentSize: 1.5, confidenceFloor: 0.75 };
    const expected = generateHypotheses(graph, options);
    const replies = await rustExec([...seedCommands(), { cmd: 'hypotheses', ...options }]);
    const actual = reportFrom(replies);

    assert.equal(expected.meta.criticalInDegree, 5, 'out-of-range option must fall back');
    assert.equal(expected.meta.smallComponentSize, 3, 'non-integer option must fall back');
    assert.equal(expected.meta.confidenceFloor, 0.75, 'a valid option must be honoured');
    assert.deepEqual(actual.meta, expected.meta);
    assert.deepEqual(actual.hypotheses, expected.hypotheses);
  });

  it('scopes to one workspace', async () => {
    const graph = buildJsGraph();
    graph.addNode('other', 'other', { workspaceId: 'tenant-x' });
    const expected = generateHypotheses(graph, { workspaceId: 'default' });
    const replies = await rustExec([
      ...seedCommands(),
      { cmd: 'add_node', id: 'other', label: 'other', workspaceId: 'tenant-x' },
      { cmd: 'hypotheses', workspaceId: 'default' },
    ]);
    const actual = reportFrom(replies);

    assert.equal(expected.meta.nodeCount, NODES.length, 'the other workspace must not leak in');
    assert.deepEqual(actual.meta, expected.meta);
    assert.deepEqual(actual.hypotheses, expected.hypotheses);
  });
});

describe('huqan-core parity: fitness report', { skip }, () => {
  /**
   * The Rust side derives the accuracy component from its own candidate store,
   * so the review history is seeded through `add_candidate` rather than handed
   * over as a precomputed rate. The engine under test is therefore the whole
   * path — store, filter, ratio — not just the last arithmetic step.
   */
  async function rustFitness(candidates) {
    const replies = await rustExec([
      ...seedCommands(),
      ...candidateCommands(candidates),
      { cmd: 'fitness', workspaceId: 'default' },
    ]);
    return reportFrom(replies);
  }

  it('matches lib/hypothesis-fitness.js when there is no review history', async () => {
    const kernel = kernelWith(buildJsGraph(), []);
    const expected = buildFitnessReport(kernel, { workspaceId: 'default' });

    // The unmeasured component must be null, not zero — that distinction is
    // the reason the weights are renormalized at all.
    const accuracy = expected.components.find(c => c.name === 'hypothesisAccuracy');
    assert.equal(accuracy.value, null);
    assert.equal(expected.meta.scoredComponents, 3);

    assert.deepEqual(await rustFitness([]), expected);
  });

  it('matches lib/hypothesis-fitness.js when review history exists', async () => {
    const kernel = kernelWith(buildJsGraph(), REVIEW_HISTORY);
    const expected = buildFitnessReport(kernel, { workspaceId: 'default' });

    const accuracy = expected.components.find(c => c.name === 'hypothesisAccuracy');
    assert.notEqual(accuracy.value, null, 'review history must actually reach the score');
    assert.equal(expected.meta.scoredComponents, 4);

    assert.deepEqual(await rustFitness(REVIEW_HISTORY), expected);
  });

  it('lets review history change the score, so the component is not inert', async () => {
    const graph = buildJsGraph();
    const without = buildFitnessReport(kernelWith(graph, []), { workspaceId: 'default' });
    const with_ = buildFitnessReport(kernelWith(graph, REVIEW_HISTORY), { workspaceId: 'default' });

    assert.notEqual(without.score, with_.score, 'the two fixtures must exercise different paths');
    assert.equal((await rustFitness([])).score, without.score);
    assert.equal((await rustFitness(REVIEW_HISTORY)).score, with_.score);
  });
});
