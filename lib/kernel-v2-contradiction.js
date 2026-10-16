'use strict';

const { detectTypeLatticeConflict } = require('./type-lattice');
const {
  toPathEvidence,
  aggregatePathConfidence,
  buildReasoningPath,
} = require('./kernel-v2-evidence');
const { buildNegationConflict } = require('./kernel-v2-type-negation');
const { OPPOSITE_PREDICATES } = require('./kernel-v2-native');

/**
 * Contradiction detail inference for a parsed verification claim.
 *
 * Moved verbatim from KernelV2._buildContradictionDetails and
 * KernelV2._findOppositePredicateConflict (#2138). The inference order is
 * the contract: fact-edge negation first (delegated to
 * buildNegationConflict), then the opposite-predicate map, then the type
 * lattice, then the type chain -- negated and affirmative claims diverge
 * only at the chain.
 *
 * Collaborators arrive as an explicit object so this module never reaches
 * into v2 internals. `v2` itself is passed through to buildNegationConflict
 * only -- this module never touches a v2 private (asserted by test and by
 * check-module-boundary), the same shape as the earlier negation slice.
 */
function findOppositePredicateConflict(collaborators, subject, normalizedTargetToken, maxDepth = 4, workspaceId = 'default') {
  const { collectPredicateTargets, inferTypeChain, buildPredicateEvidence } = collaborators;
  const opposite = OPPOSITE_PREDICATES.get(normalizedTargetToken);
  if (!opposite) return null;

  const directOpposite = collectPredicateTargets(subject, workspaceId).find(item => item.target === opposite);
  if (directOpposite) {
    return {
      status: 'contradicted',
      confidence: Math.max(0.65, Math.min(0.9, directOpposite.weight || 0.72)),
      inferred: true,
      contradictionReason: 'opposite_predicate_conflict',
      conflictTarget: directOpposite.rawTarget,
      requestedTarget: normalizedTargetToken,
      confidenceSource: 'opposite-predicate-map',
      evidence: buildPredicateEvidence(subject, workspaceId),
      meta: { inferredBy: 'opposite-predicate-conflict' },
    };
  }

  const oppositeChain = inferTypeChain(subject, opposite, maxDepth, workspaceId);
  if (!oppositeChain) return null;

  return {
    status: 'contradicted',
    confidence: aggregatePathConfidence(oppositeChain),
    inferred: true,
    contradictionReason: 'opposite_predicate_conflict',
    conflictTarget: opposite,
    requestedTarget: normalizedTargetToken,
    reasoningPath: buildReasoningPath(oppositeChain),
    pathLength: oppositeChain.length,
    confidenceSource: 'type-chain-opposite',
    evidence: toPathEvidence(oppositeChain),
    meta: { inferredBy: 'opposite-predicate-chain' },
  };
}

function runContradictionDetails(collaborators, parsed, normalizedTarget, normalizedTargetToken, opts = {}) {
  const {
    v2,
    graph,
    collectPredicateTargets,
    collectTypeTargets,
    inferTypeChain,
    buildPredicateEvidence,
    directTypeEvidence,
  } = collaborators;
  const childCollaborators = {
    collectPredicateTargets,
    inferTypeChain,
    buildPredicateEvidence,
  };
  const maxDepth = opts.maxDepth || 4;
  const workspaceId = (typeof opts.workspaceId === 'string' && opts.workspaceId.trim()) || 'default'; // #734: never silently fall back to the default workspace
  // Fact edges first, then type edges (#1989); see lib/kernel-v2-type-negation.js.
  const negationConflict = buildNegationConflict(v2, parsed, normalizedTarget, normalizedTargetToken, workspaceId);
  if (negationConflict) return negationConflict;

  if (!parsed.isNegated) {
    const oppositeConflict = findOppositePredicateConflict(
      childCollaborators,
      parsed.subject,
      normalizedTargetToken,
      maxDepth,
      workspaceId
    );
    if (oppositeConflict) {
      return oppositeConflict;
    }
  }

  if (!parsed.isNegated) {
    const knownTypes = collectTypeTargets(parsed.subject, workspaceId);
    const typeConflict = detectTypeLatticeConflict(
      graph,
      parsed.subject,
      normalizedTarget,
      workspaceId,
    );
    if (typeConflict) {
      return {
        status: 'contradicted',
        confidence: typeConflict.confidence || 0.72,
        inferred: true,
        contradictionReason: 'type_mismatch_with_known_types',
        knownTypes,
        requestedType: normalizedTarget,
        confidenceSource: 'type-lattice-conflict',
        evidence: typeConflict.evidence || directTypeEvidence(parsed.subject, workspaceId),
        meta: { inferredBy: 'type-conflict' },
      };
    }
  }

  const chain = inferTypeChain(parsed.subject, normalizedTarget, maxDepth, workspaceId);
  if (chain && parsed.isNegated) {
    return {
      status: 'contradicted',
      confidence: aggregatePathConfidence(chain),
      inferred: true,
      contradictionReason: 'negated_statement_conflicts_with_type_chain',
      reasoningPath: buildReasoningPath(chain),
      pathLength: chain.length,
      confidenceSource: 'path-average',
      evidence: toPathEvidence(chain),
      meta: { inferredBy: 'type-chain-negation' },
    };
  }

  if (chain && !parsed.isNegated) {
    return {
      status: 'verified',
      confidence: aggregatePathConfidence(chain),
      inferred: true,
      reasoningPath: buildReasoningPath(chain),
      pathLength: chain.length,
      confidenceSource: 'path-average',
      evidence: toPathEvidence(chain),
      meta: { inferredBy: 'type-chain' },
    };
  }

  return null;
}

module.exports = { runContradictionDetails, findOppositePredicateConflict };
