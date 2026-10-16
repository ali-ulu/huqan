'use strict';

/**
 * The causal-strength default for edge writes.
 *
 * graph.js::addEdge refuses a causal relation whose options carry no
 * `strength`, and it refuses by throwing rather than by returning null:
 *
 *   Causal relation 'PREVENTS' requires strength field (0-1)
 *
 * That is the correct contract -- a causal edge without a strength is not a
 * weaker claim, it is an unanswerable one -- but it makes every writer of a
 * causal edge responsible for remembering it, and the responsibility was
 * spread by copy. lib/learn-use-case.js carried the rule inline at two call
 * sites; lib/conflict-detector.js carried its own copy; and
 * plugins/company-brain.js carried none, which is why manual and decision
 * ingest threw on exactly the four relations HUQAN advertises as its core
 * capability.
 *
 * One definition, so a fifth writer inherits the rule instead of rediscovering
 * it through a stack trace.
 *
 * The relation list is graph.js's own CAUSAL_RELATIONS, read from the module
 * rather than restated, so the guard here cannot drift from the check it
 * exists to satisfy.
 */

const { CAUSAL_RELATIONS } = require('../graph');

/**
 * 0.8 rather than the caller's evidence confidence.
 *
 * Causal strength and evidence confidence are different quantities: how
 * strongly A drives B is not how sure we are that someone said so. Conflating
 * them would let a low-confidence source silently weaken a causal claim that
 * the text stated absolutely. 0.8 is the value lib/learn-use-case.js has
 * always used, and the graph the verifier reads was built with it, so this is
 * the established default rather than a new one.
 */
const DEFAULT_CAUSAL_STRENGTH = 0.8;

const CAUSAL_RELATION_SET = new Set(CAUSAL_RELATIONS);

function isCausalRelation(relation) {
  return CAUSAL_RELATION_SET.has(relation);
}

/**
 * Return `edgeOptions` with a causal `strength` guaranteed when the relation
 * needs one.
 *
 * A caller-supplied strength always wins, including an explicit 0: the point is
 * to supply a missing value, never to overwrite a deliberate one. Non-causal
 * relations are returned untouched, so nothing gains a field it has no use for.
 */
function withCausalStrength(relation, edgeOptions = {}) {
  if (!isCausalRelation(relation)) return edgeOptions;
  if (edgeOptions.strength !== undefined) return edgeOptions;
  return { ...edgeOptions, strength: DEFAULT_CAUSAL_STRENGTH };
}

module.exports = {
  DEFAULT_CAUSAL_STRENGTH,
  isCausalRelation,
  withCausalStrength,
};
