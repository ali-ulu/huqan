'use strict';

/**
 * KernelV2's negation contradiction path: "X is not Y" against what the graph
 * already asserts about X.
 *
 * Two edge families can carry that conflict, and they are not the same thing:
 * a fact edge (`yapabilir`) and a type edge (`tur`). #1989 needed the type half
 * -- "Ali doktor degildir" must contradict `ali --[tur]--> doktor`.
 *
 * #2065 reached that by widening `_collectFactTargets` and
 * `_buildDirectFactEvidence` to accept type relations as well. That collapsed
 * the two categories into one helper and broke #734's workspace-isolation
 * contract, whose whole point is that `_collectFactTargets` returns fact edges
 * and nothing else: `_collectFactTargets('kedi', 'default')` started returning
 * the `tur` target `hayvan` alongside the `yapabilir` target `ucar`.
 *
 * Owning both halves here keeps the categories separate at their source, so
 * neither helper has to lie about what it collects, and keeps kernel.v2.js
 * inside its size budget (#328).
 */

function toFactShape(v2, edge) {
  return {
    relation: edge.relation,
    target: v2._normalizePredicateToken(edge.to),
    rawTarget: edge.to,
    weight: edge.weight,
  };
}

function collectTypeTargetsAsFacts(v2, subject, workspaceId = 'default') {
  return v2.kernel.graph
    .getEdges(subject, workspaceId)
    .filter(edge => v2._isTypeRelation(edge.relation))
    .map(edge => toFactShape(v2, edge));
}

function conflictDetail(match, normalizedTarget, evidence) {
  return {
    status: 'contradicted',
    confidence: Math.max(0.65, Math.min(0.9, match.weight || 0.72)),
    inferred: true,
    contradictionReason: 'negated_statement_conflicts_with_known_fact',
    conflictTarget: normalizedTarget,
    confidenceSource: 'known-fact-conflict',
    evidence,
    meta: { inferredBy: 'fact-negation-conflict' },
  };
}

/**
 * Returns a contradiction detail when the negated target names something the
 * subject is already known to be or do, and null otherwise so the caller falls
 * through to its remaining strategies.
 *
 * A fact edge wins over a type edge when both match, preserving the precedence
 * that existed before the type half was added.
 */
function buildNegationConflict(v2, parsed, normalizedTarget, normalizedTargetToken, workspaceId = 'default') {
  if (!parsed.isNegated) return null;

  const directFact = v2._collectFactTargets(parsed.subject, workspaceId)
    .find(item => item.target === normalizedTargetToken);
  if (directFact) {
    return conflictDetail(directFact, normalizedTarget, v2._buildDirectFactEvidence(parsed.subject, workspaceId));
  }

  const directType = collectTypeTargetsAsFacts(v2, parsed.subject, workspaceId)
    .find(item => item.target === normalizedTargetToken);
  if (directType) {
    return conflictDetail(directType, normalizedTarget, v2._buildDirectTypeEvidence(parsed.subject, workspaceId));
  }

  return null;
}

module.exports = { collectTypeTargetsAsFacts, buildNegationConflict };
