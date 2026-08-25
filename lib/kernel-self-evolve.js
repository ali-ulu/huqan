'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

/**
 * The collaborator set selfEvolve runs against, built here rather than inline
 * at the call site so the workspace is applied in one place. #1189: the caller
 * used to wire these up without a workspace, so a run against any workspace but
 * 'default' read an empty graph and reported success with zero counters.
 */
function buildSelfEvolveCollaborators(kernel, Dream, workspaceId) {
  return {
    createDreams: () => new Dream(kernel).dream({ workspaceId }),
    graph: kernel.graph,
    commitBackgroundEdge: (from, to, relation, source, commitOpts) =>
      kernel._commitBackgroundEdge(from, to, relation, source, { ...commitOpts, workspaceId }),
    // consolidate() is left unscoped on purpose: consolidateEdges groups by
    // keys that omit the workspace (#1081), so passing one here would look like
    // a guarantee it cannot keep. optimize() does take a scope, so it gets one.
    consolidate: dryRun => kernel.consolidate(dryRun),
    optimize: () => kernel.graph.optimize(workspaceId),
    save: () => kernel.graph.save(),
    getDreamCount: () => kernel._dreamCount,
    setDreamCount: value => { kernel._dreamCount = value; },
  };
}

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
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
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

    // Scoped: an edge with the same endpoints in another workspace is not this
    // workspace's duplicate, and treating it as one skipped real hypotheses.
    const existing = graph.getEdge(h.from, h.to, rel, workspaceId);
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

  if (added.length > 0 || cons.removed > 0 || opt.pruned > 0) {
    try { save(); } catch (e) { logSaveError(e); }
  }

  let dreamCount = getDreamCount();
  dreamCount = (dreamCount || 0) + 1;
  setDreamCount(dreamCount);

  return {
    workspaceId,
    dreams: dreams.length,
    added: added.length,
    addedDetails: added,
    deferred: deferred.length,
    deferredDetails: deferred,
    consolidated: cons.removed,
    optimized: opt.pruned,
  };
}

module.exports = { runSelfEvolve, buildSelfEvolveCollaborators };
