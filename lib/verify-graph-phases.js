const { edgeClaim, pathSupportConfidence } = require("./verify-native");
const { phraseMatches, normalizeForVerify } = require("./verify-turkish-text");
const { analyzeFuzzyOverlap } = require("./fuzzy-normalization");
const { runSemanticSignals } = require("./semantic-signals");
const { detectTypeLatticeConflict } = require("./type-lattice");

// VerifyService#verify (lib/verify.js), past the subject's own edges: type
// lattice, recorded contradictions, a supporting path, numeric mismatch and a
// word-level partial match. Always returns a result.
function verifyAgainstGraph(service, ctx) {
  const verdict = (...args) => service.verifyResult(...args);
  const {
    statement, opts, workspaceId, parts, subject, predicate, edges, verifyContext,
    target, incomingAbsolute, normalizedPredicate, incoming,
  } = ctx;
  const typeConflict = target && target !== subject
    ? detectTypeLatticeConflict(service.kernel.graph, subject, target, workspaceId, {})
    : null;
  if (typeConflict) {
    return verdict(statement, opts, { status: 'contradicted', confidence: typeConflict.confidence || 0.9 }, typeConflict.evidence || [{
      kind: 'contradiction',
      text: typeConflict.detail,
      confidence: typeConflict.confidence,
      nodes: [subject, target],
      edges: [],
    }], { ...verifyContext, typeConflict });
  }

  const cons = service.kernel.detectContradictions(subject, workspaceId);
  // #1988: a bare node===subject match spread one contradiction onto every
  // untaught claim about the same subject. Only claims whose predicate
  // target touches the contradiction's targets count; the rest fall
  // through to unknown below.
  const subjCons = cons.filter(c => c.node === subject).filter((c) => {
    const targets = Array.isArray(c.targets) ? c.targets : [];
    return targets.some((t) => {
      const nt = normalizeForVerify(service.kernel, t);
      return phraseMatches(normalizedPredicate, nt) || phraseMatches(nt, normalizedPredicate)
        || phraseMatches(target, nt) || phraseMatches(nt, target);
    });
  });
  if (subjCons.length > 0) {
    const evidence = subjCons.map(c => service.contradictionEvidence(c));
    return verdict(statement, opts, { status: 'contradicted', confidence: 0.7 }, evidence, verifyContext);
  }

  if (target !== subject) {
    const pathResult = typeof service.kernel._findPathWithTimeout === 'function'
      ? service.host.findPathWithTimeout(subject, target, opts.pathTimeoutMs ?? 100, workspaceId, 4)
      : { path: service.host.findPath(subject, target, new Set(), [], 4, workspaceId), stoppedReason: null, timeoutMs: opts.pathTimeoutMs ?? 100, maxDepth: 4, workspaceId, visitedCount: 0 };
    if (pathResult.path && !incomingAbsolute) {
      const confidence = pathSupportConfidence(service.kernel.graph, pathResult.path, workspaceId);
      return verdict(statement, opts, { status: 'verified', confidence }, [service.host.pathEvidence(pathResult.path, 'path', confidence)], { ...verifyContext, pathSearch: pathResult });
    }
  }

  const stmtNums = predicate.match(/\d+/g);
  if (stmtNums && edges.length > 0) {
    for (const edge of edges) {
      const edgeNums = String(edge.to).match(/\d+/g);
      if (edgeNums) {
        const mismatch = stmtNums.some((n, i) => edgeNums[i] && n !== edgeNums[i]);
        if (mismatch) {
          const stmtWords = parts.slice(1).filter(p => !/^\d+$/.test(p) && p.length > 1);
          const hasTextOverlap = stmtWords.some(w => edge.to.includes(w));
          if (hasTextOverlap) {
            return verdict(statement, opts, { status: 'contradicted', confidence: 0.75 }, [{
              kind: 'contradiction',
              text: `Numeric contradiction: "${predicate}" states ${stmtNums.join(',')} but "${edge.to}" records ${edgeNums.join(',')}`,
              confidence: 0.75,
              nodes: [subject, edge.to],
              edges: [{ from: subject, to: edge.to, relation: edge.relation }],
            }], verifyContext);
          }
        }
      }
    }
  }

  for (const word of parts.slice(1)) {
    // Word boundaries, which the bare `e.to.includes(w)` did not respect:
    // 'a', 'ay' and 'van' each matched the `hayvan` edge, after which the
    // semantic signals produced a 0.75 contradiction citing it. "kedi van
    // gogh" was contradicted on nothing but overlapping letters (#1032).
    //
    // phraseMatches alone is too narrow here. Edge targets are often whole
    // phrases ("is in frankfurt"), and a single statement word that is a
    // genuine *word* of such a phrase is a real match — phraseMatches has no
    // word-membership rule, only equality, multi-word containment and a
    // four-character substring floor. So membership is tested explicitly and
    // phraseMatches still covers morphological overlap.
    const w = normalizeForVerify(service.kernel, word);
    const match = edges.find(e => {
      const target = normalizeForVerify(service.kernel, e.to);
      if (target === w) return true;
      if (target.split(/\s+/).includes(w)) return true;
      return phraseMatches(w, target);
    });
    if (match) {
      const candidate = edgeClaim(match);
      const semanticSignals = runSemanticSignals(candidate, incoming, {});
      const fuzzy = analyzeFuzzyOverlap(candidate.text, statement, { minOverlap: 2 });
      const contradictionSignals = semanticSignals.signals.filter(signal => signal.kind === 'contradiction');
      if (contradictionSignals.length > 0) {
        const evidence = contradictionSignals.map(signal => ({
          kind: 'contradiction',
          text: signal.detail || statement,
          confidence: signal.confidence,
          nodes: [subject, match.to],
          edges: [{ from: subject, to: match.to, relation: match.relation }],
        }));
        return verdict(statement, opts, { status: 'contradicted', confidence: 0.75 }, evidence, { ...verifyContext, fuzzy });
      }
      if (incomingAbsolute || fuzzy.isWeak) continue;
      return verdict(statement, opts, { status: 'verified', confidence: 0.35 }, [service.host.edgeEvidence(match, 'partial_match', 0.35)], { ...verifyContext, fuzzy });
    }
  }

  return verdict(statement, opts, { status: 'unknown', confidence: 0 }, [], verifyContext);
}

module.exports = { verifyAgainstGraph };
