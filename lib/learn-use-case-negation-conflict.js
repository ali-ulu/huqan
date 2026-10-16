'use strict';

const { normalizeNegationTarget } = require('./verify-turkish-text');

/**
 * Negation-conflict detection for the learn path (#3912).
 *
 * A negation over a fact predicate ("kedi ucamaz" against a known "kedi
 * ucabilir") is a conflict the caller has to see, but the `değil` branch in
 * lib/learn-use-case.js only handled the copula case (`tür` downgrade). A
 * learned fact negation was reported as `conflicts: []`, so learn claimed a
 * clean write while the graph then held A and ¬A and `verify` returned
 * `verified` for both.
 *
 * Split out of lib/learn-use-case.js to keep that file inside its 400-line
 * budget (check-file-size / architecture tracker). It reads edges and builds
 * conflict records only -- no graph sink -- so the entry module keeps its
 * sink count and the mutation-admission ledger is unchanged.
 *
 * `normalizeNegationTarget` collapses the -abilir/-amaz pair onto one stem
 * ('ucabilir' and 'ucamaz' both -> 'uc'), the same comparison `verify` uses to
 * refute the affirmative claim.
 *
 * Only `tür` and `yapabilir` are opposable. A causal edge ("fire CAUSES smoke")
 * does not assert that fire *is* smoke, so a negation of the same target is not
 * a conflict with it. This mirrors detectContradictions
 * (lib/verify-contradiction-scan.js), which compares the same two relations.
 *
 * @param {Array<object>} edges the subject's edges in the workspace
 * @param {string} subject
 * @param {string} object the negated predicate target
 * @returns {Array<object>} conflict records to append to the learn result
 */
const OPPOSABLE_RELATIONS = new Set(['tür', 'yapabilir']);

function findNegatedFactOppositions(edges, subject, object) {
  const negatedStem = normalizeNegationTarget(object);
  if (!negatedStem) return [];
  return edges
    .filter(edge => OPPOSABLE_RELATIONS.has(edge.relation))
    .filter(edge => normalizeNegationTarget(edge.to) === negatedStem)
    .map(edge => ({
      type: 'negation',
      subject,
      relation: 'değil',
      current: object,
      existing: edge.to,
      message: `"${subject}" is being asserted as "not ${object}", but "${edge.to}" is already known`,
      confidence: 0,
    }));
}

module.exports = { findNegatedFactOppositions };
