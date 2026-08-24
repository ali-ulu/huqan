'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RustGraph = require('../../rustGraph');
const { runSandboxed } = require('../../sandboxRunner');
const { evaluateCodeChange } = require('../code-change-gate');
const {
  SOURCE_DOGFOOD_VERSION,
  DEPENDENCY_RELATION,
  buildDependencyGraph,
  dreamDependencyCandidates,
  selectCandidate,
} = require('./source-dependency-graph');

const SANDBOX_SIMULATION_SOURCE = `(() => {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const candidate = input.candidate || {};
  if (!nodes.includes(candidate.from) || !nodes.includes(candidate.to)) {
    return { ok: false, reason: 'candidate_node_missing' };
  }
  if (candidate.from === candidate.to) return { ok: false, reason: 'self_edge_rejected' };
  const adjacency = {};
  for (const node of nodes) adjacency[node] = [];
  for (const edge of edges) {
    if (adjacency[edge.from] && adjacency[edge.to]) adjacency[edge.from].push(edge.to);
  }
  const pending = [candidate.to];
  const seen = {};
  let closesCycle = false;
  while (pending.length) {
    const current = pending.pop();
    if (current === candidate.from) { closesCycle = true; break; }
    if (seen[current]) continue;
    seen[current] = true;
    for (const next of adjacency[current] || []) pending.push(next);
  }
  return { ok: true, beforeEdges: edges.length, afterEdges: edges.length + 1, closesCycle };
})()`;

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function simulateInSandbox(dependencyGraph, candidate) {
  const result = runSandboxed(SANDBOX_SIMULATION_SOURCE, {
    input: { nodes: dependencyGraph.nodes, edges: dependencyGraph.edges, candidate },
  }, {
    // A literal defined in this file, not caller-supplied input, so its trust is
    // something this module can actually vouch for. Without the declaration AB6
    // would record it as `unknown` and quarantine it -- correct for an unproven
    // source, wrong for this one.
    sourceTrust: 'validated',
  });
  if (!result.ok || !result.data || result.data.ok !== true) {
    throw sourceError(
      'SELF_HEALER_SANDBOX_REJECTED',
      result.error?.message || result.data?.reason || 'sandbox simulation failed',
    );
  }
  return result.data;
}

async function compareWithRustGraph(dependencyGraph, candidate) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-sh-rust-'));
  const bridge = new RustGraph({ memoryPath: path.join(tempDir, 'memory.json') });
  const started = process.hrtime.bigint();
  try {
    for (const node of dependencyGraph.nodes) await bridge.addNode(node, node);
    for (const edge of dependencyGraph.edges) await bridge.addEdge(edge.from, edge.to, DEPENDENCY_RELATION);
    const before = await bridge.getStats();
    const added = await bridge.addEdge(candidate.from, candidate.to, DEPENDENCY_RELATION);
    if (!added) throw sourceError('SELF_HEALER_RUST_GRAPH_REJECTED', 'rustGraph rejected the candidate edge');
    const after = await bridge.getStats();
    return {
      backend: bridge._fallback ? 'js-fallback' : 'rust',
      before: { nodes: Number(before.nodes || 0), edges: Number(before.edges || 0) },
      after: { nodes: Number(after.nodes || 0), edges: Number(after.edges || 0) },
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  } finally {
    if (bridge._fallback && typeof bridge._fallback.close === 'function') bridge._fallback.close();
    bridge.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildCodeChangeGate(candidate, workspaceId) {
  return evaluateCodeChange({
    intent: 'Self-Healer dependency-change candidate review',
    operationType: 'preview',
    files: [{ path: candidate.from, status: 'modified', changeType: 'source' }],
    patchMetadata: { fileCount: 1, additions: 0, deletions: 0 },
    repoState: {
      branch: 'self-healer-simulation',
      isMain: false,
      dirty: false,
      hasUntracked: false,
    },
    metadata: { workspaceId },
  });
}

function buildFinding(candidate, sandbox, rustComparison, gate, dependencyGraph = {}) {
  const truncated = dependencyGraph.truncated === true;
  const cycleText = sandbox.closesCycle
    ? 'would close a dependency cycle'
    : 'does not close a dependency cycle';
  const completenessText = truncated
    ? ` The dependency graph was truncated at ${dependencyGraph.maxFiles} files, so this is incomplete evidence.`
    : '';
  const riskFlags = ['runtime_mutation', 'dependency_setup'];
  if (truncated) riskFlags.push('dependency_graph_truncated');
  if (gate.decision === 'block') riskFlags.unshift('code_change_gate_block');
  return {
    kind: 'unsafe_pattern',
    severity: truncated ? 'medium' : (sandbox.closesCycle ? 'high' : 'medium'),
    confidence: Math.max(0, Math.min(truncated ? 0.5 : 1, candidate.confidence || 0.5)),
    title: `Dependency candidate: ${candidate.from} -> ${candidate.to}`,
    summary: `Dream proposed a dependency edge for review; sandbox ${cycleText}.${completenessText} No patch was generated or applied.`,
    evidence: [
      { type: 'file', ref: candidate.from, detail: `source dependency graph target; hypothesis=${candidate.hypothesisType}` },
      { type: 'manual', ref: `sandbox:${candidate.candidateId}`, detail: `${cycleText}; edges ${sandbox.beforeEdges}->${sandbox.afterEdges}` },
      { type: 'manual', ref: `rustGraph:${candidate.candidateId}`, detail: `backend=${rustComparison.backend}; edges ${rustComparison.before.edges}->${rustComparison.after.edges}` },
      { type: 'manual', ref: `code-change-gate:${candidate.candidateId}`, detail: `decision=${gate.decision}; reason=${gate.reason}` },
    ],
    affectedFiles: [candidate.from],
    suggestedTests: ['npm test'],
    suggestedFix: {
      summary: `Review whether ${candidate.from} should depend directly on ${candidate.to}; no patch content is included.`,
      allowedFiles: [candidate.from],
      forbiddenFiles: [],
      risk: sandbox.closesCycle ? 'high' : 'medium',
    },
    riskFlags,
  };
}

async function simulateSourceCandidate(input = {}) {
  const dependencyGraph = buildDependencyGraph(input);
  const hypotheses = dreamDependencyCandidates(dependencyGraph);
  const candidate = selectCandidate(dependencyGraph, hypotheses);
  if (!candidate) {
    return {
      ok: true,
      version: SOURCE_DOGFOOD_VERSION,
      targetPath: dependencyGraph.targetPath,
      graph: {
        nodes: dependencyGraph.nodes,
        edges: dependencyGraph.edges,
        truncated: dependencyGraph.truncated,
        maxFiles: dependencyGraph.maxFiles,
      },
      candidate: null,
      applied: false,
      patchIncluded: false,
      hypothesisCount: hypotheses.length,
    };
  }
  const sandbox = simulateInSandbox(dependencyGraph, candidate);
  const rustComparison = await compareWithRustGraph(dependencyGraph, candidate);
  const workspaceId = String(input.workspaceId || 'default');
  const gate = buildCodeChangeGate(candidate, workspaceId);
  return {
    ok: true,
    version: SOURCE_DOGFOOD_VERSION,
    targetPath: dependencyGraph.targetPath,
    graph: {
      nodes: dependencyGraph.nodes,
      edges: dependencyGraph.edges,
      truncated: dependencyGraph.truncated,
      maxFiles: dependencyGraph.maxFiles,
    },
    candidate,
    sandbox,
    rustComparison,
    codeChangeGate: gate,
    finding: buildFinding(candidate, sandbox, rustComparison, gate, dependencyGraph),
    applied: false,
    patchIncluded: false,
    hypothesisCount: hypotheses.length,
  };
}

module.exports = { SOURCE_DOGFOOD_VERSION, simulateInSandbox, compareWithRustGraph, buildCodeChangeGate, buildFinding, simulateSourceCandidate };
