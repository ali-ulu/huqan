'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const Graph = require('../../graph');
const Dream = require('../../dream');

const SOURCE_DOGFOOD_VERSION = 'self-healer-source-dogfood-v0.1.0';
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEPENDENCY_RELATION = 'requires';

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

  const nodes = [...visited].map((file) => normalizeRelativePath(path.relative(root, file))).sort();
  const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge])).values()]
    .sort((left, right) => `${left.from}\u0000${left.to}`.localeCompare(`${right.from}\u0000${right.to}`));
  return { root, targetPath: normalizeRelativePath(path.relative(root, targetAbsolute)), nodes, edges: uniqueEdges };
}

function dreamDependencyCandidates(dependencyGraph) {
  const graph = new Graph({ useSQLite: false });
  for (const node of dependencyGraph.nodes) graph.addNode(node, node);
  for (const edge of dependencyGraph.edges) graph.addEdge(edge.from, edge.to, DEPENDENCY_RELATION);
  const kernel = { graph, detectGaps: () => [], plugins: { emit: (_event, data) => data } };
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
      return Number(right.confidence || 0) - Number(left.confidence || 0)
        || String(left.to).localeCompare(String(right.to));
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

module.exports = {
  SOURCE_DOGFOOD_VERSION,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  DEPENDENCY_RELATION,
  buildDependencyGraph,
  dreamDependencyCandidates,
  selectCandidate,
};
