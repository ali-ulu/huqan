'use strict';

/**
 * Hypothesis generators for `Dream#dream()`, split out of the root `dream.js`
 * (#2120). Each finder reads only the precomputed dream context plus the
 * graph/kernel handed in as parameters, and appends to `hypotheses`.
 *
 * The contradiction detector call and its failure telemetry stay in Dream,
 * because the skip counters are Dream instance state; only the pure filtering
 * of detector output lives here.
 */

const { isSymmetricRelation, nodesAreDisjoint, isEligibleHypothesisNode } = require('./dream-hypothesis-semantics');

const MAX_DREAM_COMPARISONS = 10_000;
const MAX_DREAM_WORK = 50_000;

function createDreamContext(graph, nodes, workspaceId = 'default') {
  const outEdges = new Map();
  const inEdges = new Map();
  const outTargets = new Map();
  const edgesByTarget = new Map();
  const relationTargets = new Map();
  const allowedNodeIds = new Set(nodes.map(node => node.id));
  let degreeTotal = 0;

  for (const node of nodes) {
    const outgoing = graph.getEdges(node.id, workspaceId)
      .filter(edge => allowedNodeIds.has(edge.to));
    const incoming = graph.getInEdges(node.id, workspaceId)
      .filter(edge => allowedNodeIds.has(edge.from));
    outEdges.set(node.id, outgoing);
    inEdges.set(node.id, incoming);
    outTargets.set(node.id, new Set(outgoing.map(edge => edge.to)));

    const byTarget = new Map();
    const byRelation = new Map();
    for (const edge of outgoing) {
      if (!byTarget.has(edge.to)) byTarget.set(edge.to, edge);
      if (!byRelation.has(edge.relation)) byRelation.set(edge.relation, new Set());
      byRelation.get(edge.relation).add(edge.to);
    }
    edgesByTarget.set(node.id, byTarget);
    relationTargets.set(node.id, byRelation);
    degreeTotal += outgoing.length + incoming.length;
  }

  return {
    nodes,
    workspaceId,
    // #1213: memoised type ancestors, so the disjointness guard on the
    // O(n²) similarity pass does not re-walk the lattice per pair.
    typeAncestors: new Map(),
    outEdges,
    inEdges,
    outTargets,
    edgesByTarget,
    relationTargets,
    avgDeg: degreeTotal / Math.max(1, nodes.length),
    comparisonsRemaining: MAX_DREAM_COMPARISONS,
    workRemaining: MAX_DREAM_WORK,
  };
}

function consumeDreamWork(context, kind = 'work') {
  if (context.workRemaining <= 0) return false;
  if (kind === 'comparison') {
    if (context.comparisonsRemaining <= 0) return false;
    context.comparisonsRemaining--;
  }
  context.workRemaining--;
  return true;
}

function findSimilarityHypotheses(graph, nodes, hypotheses, context) {
  const checked = new Set();
  let added = 0;
  for (let i = 0; i < nodes.length && added < 50; i++) {
    for (let j = i + 1; j < nodes.length && added < 50; j++) {
      if (!consumeDreamWork(context, 'comparison')) return;
      const a = nodes[i], b = nodes[j];
      const key = `${a.id}|${b.id}`;
      if (checked.has(key)) continue;
      checked.add(key);

      const aTargets = context.outTargets.get(a.id);
      const bTargets = context.outTargets.get(b.id);
      const common   = [...aTargets].filter(t => bTargets.has(t));

      // #1213: the lattice already says these two cannot both apply, so a
      // similarity edge between them can only ever be rejected -- after
      // costing a reviewer's attention in the approval queue.
      const disjoint = nodesAreDisjoint(
        nodeId => context.outEdges.get(nodeId), a.id, b.id, context.workspaceId, context.typeAncestors);

      if (common.length > 0 && !disjoint) {
        const existing = context.relationTargets.get(a.id)?.get('benzer')?.has(b.id)
                      || context.relationTargets.get(b.id)?.get('benzer')?.has(a.id);
        if (!existing) {
          const avgWeight = common.reduce((s, t) => {
            const ae = context.edgesByTarget.get(a.id).get(t);
            const be = context.edgesByTarget.get(b.id).get(t);
            return s + (ae ? ae.weight : 0) + (be ? be.weight : 0);
          }, 0) / (common.length * 2);
          hypotheses.push({
            type: 'benzerlik',
            from: a.id,
            to: b.id,
            via: common[0],
            confidence: Math.min(0.7, 0.2 + avgWeight * 0.4 * common.length),
            ortak_sayısı: common.length,
          });
          added++;
        }
      }

      const sim = disjoint ? 0 : graph.cosineSimilarity(a.id, b.id, context.workspaceId);
      if (sim > 0.5) {
        const hasEdge = context.outTargets.get(a.id).has(b.id)
                     || context.outTargets.get(b.id).has(a.id);
        if (!hasEdge) {
          // #3040: `graph.vector` is a sparse tag counter (`addTag` does
          // `v[dim] += weight`), so this cosine measures label co-occurrence,
          // not semantic similarity. Receipt it as such -- `kind` says what
          // the signal really is and `semantic: false` denies the embedding
          // reading -- and keep the confidence low, because sharing generic
          // tags is weak evidence.
          hypotheses.push({
            type: 'vektör-benzerlik',
            from: a.id,
            to: b.id,
            confidence: Math.min(0.3, sim * 0.6),
            benzerlik: sim,
            kind: 'co-occurrence-similarity',
            semantic: false,
          });
          added++;
        }
      }
    }
  }
}

function findTransitiveHypotheses(nodes, hypotheses, context) {
  let added = 0;
  for (const node of nodes) {
    if (added >= 50) break;
    const edges = context.outEdges.get(node.id);
    for (const edge of edges) {
      if (added >= 50) break;
      // #1643 follow-up: the source is gated by the caller, but hop targets
      // come straight from the graph. A chain hop through or into debris
      // ("{", "[],") yields a syntactically valid, semantically empty
      // proposal -- gate both hops.
      if (!isEligibleHypothesisNode(edge.to)) continue;
      const transEdges = context.outEdges.get(edge.to) || [];
      for (const te of transEdges) {
        if (added >= 50) break;
        if (!consumeDreamWork(context)) return;
        if (te.to === node.id) continue;
        if (!isEligibleHypothesisNode(te.to)) continue;
        const existing = context.relationTargets.get(node.id)?.get(edge.relation)?.has(te.to);
        if (!existing) {
          hypotheses.push({
            type: 'zincir',
            from: node.id,
            to: te.to,
            via: edge.to,
            confidence: Math.min(0.6, edge.weight * te.weight * 3.0),
            relation: edge.relation,
          });
          added++;
        }
      }
    }
  }
}

function findGapHypotheses(kernel, graph, nodes, hypotheses, context) {
  const gaps = kernel.detectGaps(context.workspaceId);
  if (gaps.length === 0 || nodes.length < 2) return;

  let added = 0;
  for (const gapId of gaps) {
    if (added >= 50) break;
    const gapNode = graph.getNode(gapId, context.workspaceId);
    if (!gapNode) continue;

    let best = null, bestSim = 0;
    for (const n of nodes) {
      if (n.id === gapId) continue;
      if (!consumeDreamWork(context, 'comparison')) return;
      const sim = graph.cosineSimilarity(gapId, n.id, context.workspaceId);
      if (sim > bestSim) { bestSim = sim; best = n.id; }
    }

    if (best && bestSim > 0.1) {
      hypotheses.push({
        type: 'bağlantı-önerisi',
        from: gapId,
        to: best,
        confidence: Math.min(0.4, bestSim * 0.5),
        benzerlik: bestSim,
      });
      added++;
    }
  }
}

function findSymmetryHypotheses(nodes, hypotheses, context) {
  let added = 0;
  for (const node of nodes) {
    if (added >= 50) break;
    const edges = context.outEdges.get(node.id);
    for (const edge of edges) {
      if (added >= 50) break;
      if (!consumeDreamWork(context)) return;
      // #1213: `tür` is not symmetric -- a cat is an animal, an animal is not
      // a cat -- and proposing its reverse builds the two-node cycle verify's
      // `döngü` rule reports as a contradiction. Unlisted relations count as
      // asymmetric: this generator's output is a write proposal.
      if (!isSymmetricRelation(edge.relation)) continue;
      const reverse    = context.relationTargets.get(edge.to)?.get(edge.relation)?.has(node.id);
      const reverseAny = context.outTargets.get(edge.to)?.has(node.id);
      if (!reverse && !reverseAny) {
        hypotheses.push({
          type: 'simetri',
          from: edge.to,
          to: node.id,
          via: edge.relation,
          confidence: edge.weight * 0.3,
          relation: edge.relation,
        });
        added++;
      }
    }
  }
}

function appendContradictionHypotheses(contradictions, hypotheses) {
  let added = 0;
  for (const c of contradictions) {
    if (added >= 50) break;
    // #1643: a contradiction anchored on punctuation debris or between
    // id-like labels is noise, not insight -- the detector fires on graph
    // shape and cannot tell "pr | #2" from "köpek".
    if (!isEligibleHypothesisNode(c.node)) continue;
    let targets = (c.targets || []).filter(t => isEligibleHypothesisNode(t));
    // #1643: targets that differ only in their digits are the same line
    // observed twice (CI job IDs, PR numbers) -- the detector cannot know
    // that, but a hypothesis claiming they contradict each other carries
    // no information. Collapse digit runs before judging novelty.
    const idVariants = new Set(targets.map(t => String(t).replace(/\d+/g, '#').trim()));
    if (idVariants.size < Math.min(2, targets.length)) continue;
    if (targets.length === 0) continue;
    hypotheses.push({
      type: 'çelişki',
      node: c.node,
      targets,
      confidence: c.confidence || 0.4,
    });
    added++;
  }
}

module.exports = {
  createDreamContext,
  findSimilarityHypotheses,
  findTransitiveHypotheses,
  findGapHypotheses,
  findSymmetryHypotheses,
  appendContradictionHypotheses,
};
