'use strict';

function createKernelReadUseCases({
  getGraph,
  emitPlugin,
  normalizeWord,
  ok,
  reason,
  alternatives,
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
    ask(question) {
      const event = emitPlugin('beforeAsk', { question });
      const effectiveQuestion = event.question;
      const workspaceId = 'default';
      const currentGraph = graph();

      const raw = effectiveQuestion.toLowerCase().trim();
      const cleaned = raw
        .replace(/\b(nedir|kimdir|nas\u0131l|nerede|nereden|nereye|ka\u00e7|hangi)\b/gi, '')
        .trim();

      const kokeIndirge = (value) => {
        let root = value
          .replace(/mezsem$/, 'me')
          .replace(/mazsam$/, 'ma')
          .replace(/sem$/, '')
          .replace(/sam$/, '')
          .replace(/meliyim$/, 'me')
          .replace(/mal\u0131y\u0131m$/, 'ma')
          .replace(/yim$/, '')
          .replace(/y\u0131m$/, '')
          .replace(/yum$/, '')
          .replace(/y\u00fcm$/, '')
          .replace(/m$/, '')
          .replace(/im$/, '')
          .replace(/s\u0131n$/, '')
          .replace(/sin$/, '')
          .replace(/sun$/, '')
          .replace(/s\u00fcn$/, '')
          .replace(/yorsun$/, '')
          .replace(/yor$/, '');

        if (root.endsWith('meliyim')) root = root.slice(0, -7);
        return root.trim();
      };

      const ozneBul = (value) => {
        const parts = value.split(/\s+/).filter(Boolean);
        if (parts.length === 0) return { subject: 'axiom', verb: '' };

        const first = parts[0];
        const normalized = normalizeWord(first);
        if (currentGraph.getNode(normalized)) {
          return { subject: normalized, verb: parts.slice(1).join(' ') };
        }

        const verbRoot = kokeIndirge(first);
        const normalizedRoot = normalizeWord(verbRoot);
        if (currentGraph.getNode(normalizedRoot)) {
          return { subject: 'axiom', verb: normalizedRoot };
        }

        if (parts.length > 1) {
          const last = parts[parts.length - 1];
          const lastRoot = kokeIndirge(last);
          const normalizedLast = normalizeWord(lastRoot);
          const adjective = parts.slice(0, -1).join(' ') + ' ' + lastRoot;
          if (currentGraph.getNode(normalizedLast)) {
            return { subject: 'axiom', verb: adjective, sifat: parts.slice(0, -1).join(' ') };
          }

          return { subject: 'axiom', verb: value };
        }

        return { subject: normalized, verb: '' };
      };

      if (/^(neden|ni?in|niye)\b/.test(raw)) {
        const action = raw.replace(/^(neden|ni?in|niye)\s+/, '');
        const { subject } = ozneBul(action);
        const subjectId = normalizeWord(subject);
        return reason(subjectId || 'axiom');
      }

      if (/ne olur/.test(raw) || /\w+sa\b/.test(raw) || /\w+se\b/.test(raw)) {
        const action = raw.replace(/\s+ne olur.*$/, '').replace(/\s+olursa.*$/, '').trim();
        const { subject, verb } = ozneBul(action);
        const subjectId = currentGraph.getNode(verb && normalizeWord(verb)) ? normalizeWord(verb) : normalizeWord(subject);
        if (currentGraph.getNode(subjectId)) {
          return reason(subjectId);
        }
      }

      const parts = cleaned.split(/\s+/).filter(Boolean);
      const { subject: detected } = ozneBul(parts[0] || '');
      const node = currentGraph.getNode(detected);
      const finalSubject = node ? detected : 'axiom';
      const finalNode = currentGraph.getNode(finalSubject);

      if (!finalNode) {
        return ok('ask', { answer: 'Bilmiyorum', subject: finalSubject, unknown: true }, []);
      }

      const edges = currentGraph.getEdges(finalSubject);
      if (edges.length === 0) {
        return ok('ask', { answer: 'Bilmiyorum', subject: finalSubject, unknown: true }, []);
      }

      const hasRestriction = edges.some(edge => edge.kistlama && edge.relation === 'yapabilir');
      const allowedYapabilir = hasRestriction
        ? new Set(edges.filter(edge => edge.kistlama && edge.relation === 'yapabilir').map(edge => edge.to))
        : null;

      const sorted = [...edges].sort((left, right) => right.weight - left.weight);
      const evidence = [];
      const results = [];
      const collectTypeTargets = (start, depth, seen = new Set()) => {
        if (depth <= 0 || seen.has(start)) return [];
        seen.add(start);

        const targets = [];
        for (const edge of currentGraph.getEdges(start)) {
          if (edge.relation !== 'tür') continue;
          if (!targets.includes(edge.to)) targets.push(edge.to);
          for (const transitiveTarget of collectTypeTargets(edge.to, depth - 1, seen)) {
            if (!targets.includes(transitiveTarget)) targets.push(transitiveTarget);
          }
        }

        return targets;
      };

      for (const edge of sorted) {
        if (hasRestriction && edge.relation === 'yapabilir' && !allowedYapabilir.has(edge.to)) continue;
        evidence.push(edgeEvidence(edge));
        if (edge.relation === 'tür') {
          if (!results.includes(edge.to)) results.push(edge.to);
          const transitive = collectTypeTargets(edge.to, 2);
          for (const target of transitive) {
            if (!results.includes(target)) results.push(target);
          }
        } else if (edge.relation === 'yapabilir') {
          if (!results.includes(edge.to)) results.push(edge.to);
        } else if (!results.includes(edge.to)) {
          results.push(edge.to);
        }
      }

      const altResult = alternatives(finalSubject, 2, workspaceId);
      const altPaths = altResult.data.paths || [];
      const altText = altPaths.length > 1
        ? `\n  alternatif: ${altPaths.map(path => `[${path.type}] ${path.to}`).join(', ')}`
        : '';

      const answer = results.length === 0 ? 'Bilmiyorum' : `${finalSubject} ${results.join(', ')}${altText}`;
      emitPlugin('afterAsk', { question: effectiveQuestion, answer, alternatives: altPaths.length });
      return ok('ask', { answer, subject: finalSubject, unknown: false, alternatives: altPaths.length }, evidence);
    },

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
