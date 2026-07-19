'use strict';

function createKernelReadUseCases({
  getGraph,
  normalizeWord,
  ok,
  forwardChain,
  backwardChain,
  detectCycle,
  resolveCycleOrder,
  findPath,
  edgeEvidence,
  pathEvidence,
  edgeRef,
}) {
  if (typeof getGraph !== 'function') {
    throw new TypeError('getGraph is required');
  }

  function graph() {
    return getGraph();
  }

  return Object.freeze({
    entropy(workspaceId = 'default') {
      const currentGraph = graph();
      const allNodes = Object.values(currentGraph.getNodes(workspaceId));
      if (allNodes.length === 0) return 0;

      let totalWeight = 0;
      const weights = [];

      for (const node of allNodes) {
        const edges = currentGraph.getEdges(node.id, workspaceId);
        for (const edge of edges) {
          weights.push(edge.weight);
          totalWeight += edge.weight;
        }
      }

      if (totalWeight === 0) return 0;

      let entropy = 0;
      for (const weight of weights) {
        const probability = weight / totalWeight;
        entropy -= probability * Math.log(probability);
      }

      return entropy;
    },

    detectGaps(workspaceId = 'default') {
      const currentGraph = graph();
      const allNodes = Object.values(currentGraph.getNodes(workspaceId));
      const gaps = [];

      for (const node of allNodes) {
        const edges = currentGraph.getEdges(node.id, workspaceId);
        if (edges.length === 0) {
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
          forward: [],
          backward: [],
          cycles: [],
        }, []);
      }

      const ileri = forwardChain(normalized, [], new Set(), 4, workspaceId);
      const geri = backwardChain(normalized, [], new Set(), 4, workspaceId);
      const cycle = detectCycle(normalized, new Set(), [], workspaceId);
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
        forward: ileri.map(edge => edgeRef(edge)),
        backward: geri.map(edge => edgeRef(edge)),
        cycles: cycle ? [cycle] : [],
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
      if (foundPath) answer += '\n  ba?lant?: ' + foundPath.join(' ? ');

      return ok('compare', {
        a: aN,
        b: bN,
        answer,
        common: ortak.map(edge => edgeRef(edge)),
        onlyA: aFark.map(edge => edgeRef(edge)),
        onlyB: bFark.map(edge => edgeRef(edge)),
        paths: foundPath ? [foundPath] : [],
      }, evidence);
    },
  });
}

module.exports = {
  createKernelReadUseCases,
};
