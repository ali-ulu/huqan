'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../../graph');
const Dream = require('../../dream');
const RustGraph = require('../../rustGraph');
const { runSandboxed } = require('../../sandboxRunner');
const { evaluateCodeChange } = require('../code-change-gate');

const SOURCE_DOGFOOD_VERSION = 'self-healer-source-dogfood-v0.1.0';
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEPENDENCY_RELATION = 'requires';

const SANDBOX_SIMULATION_SOURCE = `(() => {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const candidate = input.candidate || {};
  if (!nodes.includes(candidate.from) || !nodes.includes(candidate.to)) {
    return { ok: false, reason: 'candidate_node_missing' };
  }
  if (candidate.from === candidate.to) {
    return { ok: false, reason: 'self_edge_rejected' };
  }
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
  return {
    ok: true,
    beforeEdges: edges.length,
    afterEdges: edges.length + 1,
    closesCycle,
  };
})()`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeRelativePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveInsideRoot(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || path.isAbsolute(normalized)) {
    throw sourceError('SELF_HEALER_TARGET_INVALID', 'targetPath must be a repository-relative path');
  }
  const absolute = path.resolve(root, normalized);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (absolute !== path.resolve(root) && !absolute.startsWith(prefix)) {
    throw sourceError('SELF_HEALER_TARGET_OUTSIDE_ROOT', 'targetPath escapes the repository root');
  }
  return absolute;
}

function resolveRelativeRequire(root, fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (!candidate.startsWith(rootPrefix)) continue;
    try {
      if (fs.statSync(candidate).isFile() && candidate.endsWith('.js')) return candidate;
    } catch (_) {}
  }
  return null;
}

function readBoundedSource(filePath, maxFileBytes) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxFileBytes) {
    throw sourceError(
      'SELF_HEALER_SOURCE_TOO_LARGE',
      `source file exceeds ${maxFileBytes} byte limit: ${filePath}`,
    );
  }
  return fs.readFileSync(filePath, 'utf8');
}

function extractRelativeRequires(source) {
  const specifiers = [];
  for (const match of String(source).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1].startsWith('.')) specifiers.push(match[1]);
  }
  return [...new Set(specifiers)].sort();
}

function buildDependencyGraph(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const root = path.resolve(source.root || path.join(__dirname, '..', '..'));
  const maxFiles = boundedPositiveInt(source.maxFiles, DEFAULT_MAX_FILES);
  const maxFileBytes = boundedPositiveInt(source.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const targetAbsolute = resolveInsideRoot(root, source.targetPath);
  if (!fs.existsSync(targetAbsolute) || !fs.statSync(targetAbsolute).isFile()) {
    throw sourceError('SELF_HEALER_TARGET_NOT_FOUND', `target file not found: ${source.targetPath}`);
  }
  if (!targetAbsolute.endsWith('.js')) {
    throw sourceError('SELF_HEALER_TARGET_UNSUPPORTED', 'source dogfood simulation currently supports .js files only');
  }

  const queue = [targetAbsolute];
  const visited = new Set();
  const edges = [];
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    if (visited.size >= maxFiles) {
      throw sourceError('SELF_HEALER_SOURCE_GRAPH_LIMIT', `dependency graph exceeds ${maxFiles} files`);
    }
    visited.add(current);
    const sourceText = readBoundedSource(current, maxFileBytes);
    for (const specifier of extractRelativeRequires(sourceText)) {
      const resolved = resolveRelativeRequire(root, current, specifier);
      if (!resolved) continue;
      edges.push({
        from: normalizeRelativePath(path.relative(root, current)),
        to: normalizeRelativePath(path.relative(root, resolved)),
      });
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  const nodes = [...visited]
    .map((file) => normalizeRelativePath(path.relative(root, file)))
    .sort();
  const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge])).values()]
    .sort((left, right) => `${left.from}\u0000${left.to}`.localeCompare(`${right.from}\u0000${right.to}`));

  return {
    root,
    targetPath: normalizeRelativePath(path.relative(root, targetAbsolute)),
    nodes,
    edges: uniqueEdges,
    maxFiles,
    maxFileBytes,
  };
}

function dreamDependencyCandidates(dependencyGraph) {
  const graph = new Graph({ useSQLite: false });
  for (const node of dependencyGraph.nodes) graph.addNode(node, node);
  for (const edge of dependencyGraph.edges) graph.addEdge(edge.from, edge.to, DEPENDENCY_RELATION);
  const kernel = {
    graph,
    detectGaps: () => [],
    plugins: { emit: (_event, data) => data },
  };
  const hypotheses = new Dream(kernel).dream();
  if (typeof graph.close === 'function') graph.close();
  return hypotheses;
}

function selectCandidate(dependencyGraph, hypotheses) {
  const existing = new Set(dependencyGraph.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  const nodeSet = new Set(dependencyGraph.nodes);
  const priority = { zincir: 0, 'bağlantı-önerisi': 1, simetri: 2, benzerlik: 3, 'vektör-benzerlik': 4 };
  const candidates = (Array.isArray(hypotheses) ? hypotheses : [])
    .filter((item) => item && item.from === dependencyGraph.targetPath && item.to)
    .filter((item) => nodeSet.has(item.from) && nodeSet.has(item.to))
    .filter((item) => !existing.has(`${item.from}\u0000${item.to}`))
    .sort((left, right) => {
      const rank = (priority[left.type] ?? 99) - (priority[right.type] ?? 99);
      if (rank !== 0) return rank;
      const confidence = Number(right.confidence || 0) - Number(left.confidence || 0);
      return confidence || String(left.to).localeCompare(String(right.to));
    });
  if (!candidates.length) return null;
  const hypothesis = candidates[0];
  const identity = JSON.stringify({
    version: SOURCE_DOGFOOD_VERSION,
    from: hypothesis.from,
    to: hypothesis.to,
    type: hypothesis.type,
    via: hypothesis.via || '',
  });
  return {
    candidateId: `shc_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
    operation: 'review_dependency_edge',
    from: hypothesis.from,
    to: hypothesis.to,
    via: hypothesis.via || null,
    hypothesisType: hypothesis.type,
    confidence: Number(hypothesis.confidence || 0),
    applied: false,
    patchIncluded: false,
  };
}

function simulateInSandbox(dependencyGraph, candidate) {
  const result = runSandboxed(SANDBOX_SIMULATION_SOURCE, {
    input: { nodes: dependencyGraph.nodes, edges: dependencyGraph.edges, candidate },
  });
  if (!result.ok || !result.data || result.data.ok !== true) {
    throw sourceError('SELF_HEALER_SANDBOX_REJECTED', result.error?.message || result.data?.reason || 'sandbox simulation failed');
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

function buildFinding(candidate, sandbox, rustComparison, gate) {
  const cycleText = sandbox.closesCycle ? 'would close a dependency cycle' : 'does not close a dependency cycle';
  return {
    kind: 'unsafe_pattern',
    severity: sandbox.closesCycle ? 'high' : 'medium',
    confidence: Math.max(0, Math.min(1, candidate.confidence || 0.5)),
    title: `Dependency candidate: ${candidate.from} -> ${candidate.to}`,
    summary: `Dream proposed a dependency edge for review; sandbox ${cycleText}. No patch was generated or applied.`,
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
    riskFlags: ['runtime_mutation', 'dependency_setup'],
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
      candidate: null,
      applied: false,
      patchIncluded: false,
      hypothesisCount: hypotheses.length,
    };
  }

  const sandbox = simulateInSandbox(dependencyGraph, candidate);
  const rustComparison = await compareWithRustGraph(dependencyGraph, candidate);
  const gate = evaluateCodeChange({
    intent: 'Self-Healer dependency-change candidate review',
    operationType: 'preview',
    files: [{ path: candidate.from, status: 'modified', changeType: 'source' }],
    patchMetadata: { fileCount: 1, additions: 0, deletions: 0 },
    repoState: { branch: 'self-healer-simulation', isMain: false, dirty: false, hasUntracked: false },
    metadata: { workspaceId: String(input.workspaceId || 'default') },
  });

  return {
    ok: true,
    version: SOURCE_DOGFOOD_VERSION,
    targetPath: dependencyGraph.targetPath,
    graph: { nodes: dependencyGraph.nodes, edges: dependencyGraph.edges },
    candidate,
    sandbox,
    rustComparison,
    codeChangeGate: gate,
    finding: buildFinding(candidate, sandbox, rustComparison, gate),
    applied: false,
    patchIncluded: false,
    hypothesisCount: hypotheses.length,
  };
}

module.exports = {
  SOURCE_DOGFOOD_VERSION,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  buildDependencyGraph,
  dreamDependencyCandidates,
  selectCandidate,
  simulateInSandbox,
  simulateSourceCandidate,
};
