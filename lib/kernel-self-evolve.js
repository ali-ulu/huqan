'use strict';

function runSelfEvolve(
  opts = {},
  {
    createDreams,
    graph,
    commitBackgroundEdge,
    consolidate,
    optimize,
    save,
    getDreamCount,
    setDreamCount,
    logSaveError = error => console.error('[Kernel] Graph save hatası:', error.message),
  } = {},
) {
  const dreams = createDreams();

  // FAZ2-PR3 (F-001-c): self-evolution converts autonomous hypotheses into
  // canonical edges.  Each proposed edge now passes through
  // commitBackgroundEdge so synthetic provenance is attached, admission is
  // evaluated, and the attempt is audited.  By default the admission gate
  // returns 'review' for background-derived writes, so canonical writes only
  // happen when the operator has wired a higher-trust background policy.
  const added = [];
  const deferred = [];
  for (const h of dreams) {
    if (opts.minConfidence && h.confidence < opts.minConfidence) continue;
    const defaultMin = h.type === 'zincir' ? 0.25 : 0.3;
    if (h.confidence < defaultMin) continue;

    const rel = h.relation || (
      h.type === 'benzerlik' || h.type === 'vektör-benzerlik'
        ? 'benzer'
        : 'hipotez'
    );

    const existing = graph.getEdge(h.from, h.to, rel);
    if (existing) continue;

    const weight = Math.min(0.4, h.confidence * 0.8);
    const result = commitBackgroundEdge(h.from, h.to, rel, 'selfEvolve', {
      edgeOptions: { weight, source: 'kendilik' },
      provenanceExtra: {
        hypothesisType: h.type,
        hypothesisConfidence: h.confidence,
        weight,
      },
    });
    if (result.decision === 'allow' && result.edge) {
      added.push({ from: h.from, to: h.to, relation: rel, confidence: h.confidence, type: h.type });
    } else {
      deferred.push({ from: h.from, to: h.to, relation: rel, confidence: h.confidence, type: h.type, decision: result.decision });
    }
  }

  const cons = consolidate(false);
  const opt = optimize();

  if (added.length > 0 || cons.removed > 0) {
    try { save(); } catch (e) { logSaveError(e); }
  }

  let dreamCount = getDreamCount();
  dreamCount = (dreamCount || 0) + 1;
  setDreamCount(dreamCount);

  return {
    dreams: dreams.length,
    added: added.length,
    addedDetails: added,
    deferred: deferred.length,
    deferredDetails: deferred,
    consolidated: cons.removed,
    optimized: opt.pruned,
  };
}

module.exports = { runSelfEvolve };
