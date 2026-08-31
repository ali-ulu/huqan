'use strict';

const { normalizeWorkspaceId } = require('./workspace-id');

function runDream(
  opts = {},
  {
    createDreams,
    graph,
    commitBackgroundEdge,
    getDreamCount,
    setDreamCount,
    ok,
  } = {},
) {
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const raw = createDreams(opts);
  const hypotheses = raw.map(h => {
    const nodes = [h.from, h.to, h.node, ...(h.targets || [])].filter(Boolean);
    const edges = h.from && h.to ? [{ from: h.from, to: h.to, relation: h.relation || h.type || 'hypothesis' }] : [];
    return {
      ...h,
      _evidence: {
        kind: 'hypothesis',
        text: h.from && h.to ? `${h.from} ? ${h.to}` : `${nodes.join(' ? ') || 'hypothesis'}`,
        confidence: Math.max(0, Math.min(1, h.confidence || 0)),
        nodes,
        edges,
      },
    };
  });

  // Geribesleme: hipotezleri grafiğe ekle
  // FAZ2-PR3 (F-001-b): when learnFromDream is set, hypotheses are
  // background-derived candidate writes — route through admission +
  // audit instead of silent canonical writes.
  const learned = [];
  const pending = [];
  if (opts.learnFromDream !== false) {
    const threshold = opts.dreamLearnThreshold ?? 0.1;
    for (const h of hypotheses) {
      if (h.confidence > threshold && h.from && h.to) {
        const existing = graph.hasAnyEdge(h.from, h.to, workspaceId);
        if (!existing && graph.getNode(h.from, workspaceId) && graph.getNode(h.to, workspaceId)) {
          const rel = (h.relation === 'tür' || h.via === 'tür') ? 'tür'
                    : (h.relation === 'yapabilir') ? 'yapabilir'
                    : (h.relation === 'özellik') ? 'özellik'
                    : (h.type === 'zincir' || h.relation === 'benzer') ? 'benzer'
                    : 'hipotez';
          const result = commitBackgroundEdge(h.from, h.to, rel, 'dream', {
            workspaceId,
            // Opt-in admission passthrough: a caller may explicitly supply
            // admissionOpts (e.g. createAdmissionBypassOpts for a local,
            // operator-directed verification run). Default behaviour is
            // unchanged: without it, hypotheses stay admission-gated
            // (pending/review) exactly as FAZ2-PR3 intended. The key is
            // omitted entirely rather than set to undefined so the delegate
            // contract (exact opts shape) stays intact by default.
            ...(opts.admissionOpts
              ? { admissionOpts: opts.admissionOpts }
              : {}),
            provenanceExtra: {
              hypothesisType: h.type,
              hypothesisConfidence: h.confidence,
              via: h.via || null,
            },
          });
          if (result.decision === 'allow' && result.edge) {
            learned.push({ from: h.from, to: h.to, confidence: h.confidence, relation: rel });
          } else {
            pending.push({ from: h.from, to: h.to, confidence: h.confidence, relation: rel, decision: result.decision });
          }
        }
      }
    }
  }

  // Rüya döngü sayacı
  let dreamCount = getDreamCount();
  if (!dreamCount) dreamCount = 0;
  dreamCount++;
  setDreamCount(dreamCount);

  const evidence = hypotheses.map(h => h._evidence);
  return ok('dream', { hypotheses, learned, pending, cycle: dreamCount }, evidence);
}

module.exports = { runDream };
