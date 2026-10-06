'use strict';

/**
 * Delegation depth bound and visited-agent tracking (R25, #3480).
 *
 * A delegation chain is a claim about lineage: source, middles, target. Left
 * unbounded it is also a way to smuggle an arbitrarily long delegation into a
 * single exchange. The validator already refused chains over 16 entries, but
 * the bound lived inline as a magic number and nothing named the visited set.
 * This module owns both: the named `MAX_DELEGATION_DEPTH` and the ordered
 * visited-agent list, so the check reads as policy rather than arithmetic.
 *
 * Enforcement is unchanged on purpose: over-max still returns the existing
 * `delegation_chain_invalid` from `validateDelegation`, so no reason string,
 * retry allowlist entry, or wire field is added. The depth evidence travels
 * in the returned record for hosts and auditors; the block travels in the
 * same reason it always did.
 */

const MAX_DELEGATION_DEPTH = 16;
const MAX_ID_CHARS = 256;

function validId(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_ID_CHARS
    && Buffer.byteLength(value, 'utf8') <= MAX_ID_CHARS;
}

/**
 * Evaluate the depth of a delegation claim.
 *
 * Returns a frozen `{ depth, visitedAgentIds, withinBounds }` where depth
 * counts the chained agents (source through target) and visitedAgentIds is
 * their ordered copy. `withinBounds` is false for an empty chain, a chain
 * past the maximum, or a chain that revisits an agent: a "visited" set with
 * a repeat never visited anything. Malformed input (no object, no chain
 * array, non-string members) throws: that is a programmer error, not a
 * validation outcome.
 */
function evaluateDelegationDepth(delegation) {
  if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)
      || !Array.isArray(delegation.chain)
      || !delegation.chain.every(validId)) {
    throw new TypeError('delegation depth input must carry a chain of bounded agent ids');
  }
  const visitedAgentIds = Object.freeze([...delegation.chain]);
  const withinBounds = visitedAgentIds.length > 0
    && visitedAgentIds.length <= MAX_DELEGATION_DEPTH
    && new Set(visitedAgentIds).size === visitedAgentIds.length;
  return Object.freeze({
    depth: visitedAgentIds.length,
    visitedAgentIds,
    withinBounds,
  });
}

/**
 * Predicate form for the validator: true only for a well-formed chain within
 * the bound. Never throws for a validation outcome; malformed input is
 * simply out of bounds, and the caller's existing invalid branch reports it.
 */
function withinDelegationDepth(delegation) {
  try {
    return evaluateDelegationDepth(delegation).withinBounds;
  } catch (_) {
    return false;
  }
}

module.exports = Object.freeze({
  MAX_DELEGATION_DEPTH,
  evaluateDelegationDepth,
  withinDelegationDepth,
});
