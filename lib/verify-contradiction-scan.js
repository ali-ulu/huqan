const { normalizeNegationTarget } = require("./verify-turkish-text");
const { extractNumbers, getTextCore } = require('./verify-numeric-text');
const { pairMatchesDisjoint } = require("./type-lattice");
const { findNumericContradictions } = require("./verify-numeric-contradictions");

// VerifyService#detectContradictions (lib/verify.js), installed as a
// non-enumerable prototype method, as class methods are.
function detectContradictions(subject = '', workspaceId = 'default') {
  const scope = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : 'default';
  const allNodes = Object.values(this.kernel.graph.getNodes(scope)).filter(node => !subject || node.id === subject);
  const contradictions = [];

  // The five detection passes below each used to call getEdges() for the same
  // node, so every node was fetched five times -- O(5*N) graph reads on a path
  // that introspect() runs on every verify, and autoThinkTick runs every third
  // tick (#395). Fetch once up front and let each pass read from here.
  //
  // The passes stay separate rather than being fused into one node loop: the
  // returned array is ordered by contradiction type (every 'çoklu-tür', then
  // every 'döngü', ...), and fusing them would reorder it to node-major.
  // That ordering is observable to callers, so this change is purely about
  // how often the graph is read, not about what comes back.
  const edgesByNode = new Map();
  for (const node of allNodes) {
    edgesByNode.set(node.id, this.kernel.graph.getEdges(node.id, scope));
  }
  const edgesOf = nodeId => edgesByNode.get(nodeId) || [];

  for (const node of allNodes) {
    const edges = edgesOf(node.id);
    const typeEdges = edges.filter(e => e.relation === 'tür');
    for (let leftIndex = 0; leftIndex < typeEdges.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < typeEdges.length; rightIndex += 1) {
        const left = typeEdges[leftIndex];
        const right = typeEdges[rightIndex];
        if (!pairMatchesDisjoint(left.to, right.to, scope)) continue;
        contradictions.push({
          type: 'çoklu-tür',
          node: node.id,
          targets: [left.to, right.to],
          confidence: 0.95,
          edges: [left, right],
          message: `disjoint types: ${left.to}, ${right.to}`,
        });
      }
    }
  }

  // Tracks which nodes already produced a 'döngü' entry. The original guard
  // rescanned the whole contradictions array per edge; at this point the array
  // only holds 'çoklu-tür' and 'döngü' entries, so a set of node ids is an
  // exact stand-in for that scan without its O(N*E*C) cost.
  const cycleNodes = new Set();
  for (const node of allNodes) {
    const nodeEdges = edgesOf(node.id);
    for (const edge of nodeEdges) {
      if (edge.relation !== 'tür') continue;
      const backEdge = this.kernel.graph.getEdge(edge.to, node.id, 'tür', scope);
      if (backEdge && !cycleNodes.has(node.id)) {
        cycleNodes.add(node.id);
        contradictions.push({
          type: 'döngü',
          node: node.id,
          targets: [edge.to],
          confidence: 0.7,
          edges: [edge, backEdge],
          message: 'cycle detected between ' + node.id + ' and ' + edge.to,
        });
      }
    }
  }

  for (const node of allNodes) {
    const edges = edgesOf(node.id);
    const degilEdges = edges.filter(e => e.relation === 'değil');
    if (degilEdges.length === 0) continue;
    const comparableEdges = edges.filter(e => e.relation === 'tür' || e.relation === 'yapabilir');
    for (const degil of degilEdges) {
      const negatedTarget = normalizeNegationTarget(degil.to);
      for (const comparableEdge of comparableEdges) {
        if (negatedTarget && negatedTarget === normalizeNegationTarget(comparableEdge.to)) {
          contradictions.push({
            type: 'negasyon',
            node: node.id,
            targets: [degil.to, comparableEdge.to],
            confidence: 0.8,
            message: 'negation conflict for ' + node.id,
            edges: [degil, comparableEdge],
          });
        }
      }
    }
  }

  for (const node of allNodes) {
    const edges = edgesOf(node.id);
    // #1186: see lib/verify-numeric-contradictions.js for why the guards
    // are evaluated per edge rather than per pair.
    // Appended one at a time, not spread: a hub whose neighbours share a
    // text core produces a contradiction per pair, and `push(...results)`
    // passes every one as an argument -- which overflows the call stack
    // well before the array itself is a problem.
    const numeric = findNumericContradictions(edges, node.id, {
      extractNumbers: value => this.extractNumbers(value),
      getTextCore: value => this.getTextCore(value),
    });
    for (const found of numeric) contradictions.push(found);
  }

  for (const node of allNodes) {
    const edges = edgesOf(node.id);
    for (const e of edges) {
      if (e.relation === 'benzer' || e.relation === 'hipotez') continue;
      if (e.celiski) {
        contradictions.push({
          type: 'çelişki',
          node: node.id,
          targets: [e.to],
          confidence: 0.6,
          message: 'explicit conflict flag for ' + node.id,
          edges: [e],
        });
      }
    }
  }

  return contradictions;
}

function installVerifyContradictionScan(proto) {
  for (const method of [detectContradictions]) {
    Object.defineProperty(proto, method.name, {
      value: method, writable: true, configurable: true, enumerable: false,
    });
  }
}

module.exports = { installVerifyContradictionScan };
