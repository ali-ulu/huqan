'use strict';

function createAnalysisReadUseCases({ getGraph, normalizeWord, ok, forwardChain, backwardChain, detectCycle, resolveCycleOrder, findPath, edgeEvidence, pathEvidence, edgeRef }) {
  function graph() { return getGraph(); }
  return {
    entropy(workspaceId = 'default') {
      const currentGraph = graph();
      // One workspace-scoped edge read instead of one getEdges per node (#3012).
      // Entropy is a multiset over edge weights, so the traversal order is
      // irrelevant: summing the same weights in any order is the same double.
      // This is also equivalent to the old per-node walk rather than merely
      // close to it -- addEdge refuses an endpoint that has no node, and
      // removeNode purges incident edges, so no edge is ever dangling and every
      // getEdges(scope) result is already contained in getAllEdges(scope).
      // `clone: false` returns the frozen views #3012 added; nothing here
      // mutates an edge, it only reads `weight`.
      const edges = currentGraph.getAllEdges(workspaceId, { clone: false });
      if (edges.length === 0) return 0;

      let totalWeight = 0;
      const weights = [];

      for (const edge of edges) {
        weights.push(edge.weight);
        totalWeight += edge.weight;
      }

      if (totalWeight === 0) return 0;

      let entropy = 0;
      for (const weight of weights) {
        if (weight <= 0) continue;
        const probability = weight / totalWeight;
        entropy -= probability * Math.log(probability);
      }

      return entropy;
    },

    detectGaps(workspaceId = 'default') {
      const currentGraph = graph();
      // A node has no outgoing edge iff its id is not the source of any edge in
      // the workspace (#3012). Reading the edges once replaces the per-node
      // getEdges scan with a single frozen read; the answer is identical because
      // a node with no outgoing edge contributes nothing to the source set, and
      // every edge source is a live node (addEdge requires both endpoints).
      // Result order is preserved by iterating the nodes, not the source set.
      const allNodes = Object.values(currentGraph.getNodes(workspaceId, { clone: false }));
      const sources = new Set(
        currentGraph.getAllEdges(workspaceId, { clone: false }).map(edge => edge.from),
      );
      const gaps = [];

      for (const node of allNodes) {
        if (!sources.has(node.id)) {
          gaps.push(node.id);
        }
      }

      return gaps;
    },

    reason(subject, workspaceId = 'default') {
      const currentGraph = graph();
      const normalized = normalizeWord(subject);
      const node = currentGraph.getNode(normalized, workspaceId);
      if (!node) {
        return ok('reason', {
          subject: normalized,
          answer: 'Bilmiyorum',
          unknown: true,
          forward: [],
          backward: [],
          cycles: [],
        }, []);
      }

      const ileri = forwardChain(normalized, [], new Set(), 4, workspaceId);
      const geri = backwardChain(normalized, [], new Set(), 4, workspaceId);
      const cycleSearch = detectCycle(normalized, new Set(), [], workspaceId);
      const cycle = cycleSearch.cycle;
      const evidence = [
        ...ileri.map(edge => edgeEvidence(edge, 'path', 0.5)),
        ...geri.map(edge => edgeEvidence(edge, 'path', 0.5)),
      ];

      let answer = normalized + ':';
      if (ileri.length > 0) answer += '\n  neden olur: ' + ileri.map(edge => edge.to + ' [' + edge.relation + ']').join(', ');
      if (geri.length > 0) answer += '\n  nedeni: ' + geri.map(edge => edge.from + ' [' + edge.relation + ']').join(', ');
      if (cycle) {
        answer += '\n  ? döngü tespit edildi: ' + cycle.join(' ? ');
        evidence.push(pathEvidence(cycle, 'path', 0.4, workspaceId));
        const nedenOnce = resolveCycleOrder(cycle, workspaceId);
        if (nedenOnce) answer += '\n  ? ilk neden: ' + nedenOnce;
      }

      return ok('reason', {
        subject: normalized,
        answer: answer || 'Bilmiyorum',
        unknown: !answer,
        forward: ileri.map(edge => edgeRef(edge)),
        backward: geri.map(edge => edgeRef(edge)),
        cycles: cycle ? [cycle] : [],
        cycleSearch,
      }, evidence);
    },

    compare(a, b, workspaceId = 'default') {
      const currentGraph = graph();
      const normalizedA = normalizeWord(a);
      const normalizedB = normalizeWord(b);
      const na = currentGraph.getNode(normalizedA, workspaceId);
      const nb = currentGraph.getNode(normalizedB, workspaceId);
      if (!na || !nb) {
        return ok('compare', {
          a: normalizedA,
          b: normalizedB,
          answer: 'Bilmiyorum',
          unknown: true,
          common: [],
          onlyA: [],
          onlyB: [],
          paths: [],
        }, []);
      }

      const aN = na.id;
      const bN = nb.id;
      const aEdges = currentGraph.getEdges(aN, workspaceId);
      const bEdges = currentGraph.getEdges(bN, workspaceId);
      const aSet = new Set(aEdges.map(edge => edge.to + '|' + edge.relation));
      const bSet = new Set(bEdges.map(edge => edge.to + '|' + edge.relation));

      const ortak = aEdges.filter(edge => bSet.has(edge.to + '|' + edge.relation));
      const aFark = aEdges.filter(edge => !bSet.has(edge.to + '|' + edge.relation));
      const bFark = bEdges.filter(edge => !aSet.has(edge.to + '|' + edge.relation));
      const foundPath = findPath(aN, bN, new Set(), [], 5, workspaceId);

      const evidence = [
        ...ortak.map(edge => edgeEvidence(edge)),
        ...aFark.map(edge => edgeEvidence(edge, 'partial_match', 0.35)),
        ...bFark.map(edge => edgeEvidence(edge, 'partial_match', 0.35)),
      ];
      if (foundPath) evidence.push(pathEvidence(foundPath, 'path', 0.5, workspaceId));

      let answer = '?? ' + aN + ' vs ' + bN + ':';
      if (ortak.length > 0) answer += '\n  ortak: ' + ortak.map(edge => edge.to + ' [' + edge.relation + ']').join(', ');
      if (aFark.length > 0) answer += '\n  sadece ' + aN + ': ' + aFark.map(edge => edge.to + ' [' + edge.relation + ']').join(', ');
      if (bFark.length > 0) answer += '\n  sadece ' + bN + ': ' + bFark.map(edge => edge.to + ' [' + edge.relation + ']').join(', ');
      if (foundPath) answer += '\n  bağlantı: ' + foundPath.join(' ? ');

      return ok('compare', {
        a: aN,
        b: bN,
        answer,
        unknown: false,
        common: ortak.map(edge => edgeRef(edge)),
        onlyA: aFark.map(edge => edgeRef(edge)),
        onlyB: bFark.map(edge => edgeRef(edge)),
        paths: foundPath ? [foundPath] : [],
      }, evidence);
    },
  };
}

module.exports = { createAnalysisReadUseCases };
