'use strict';

const { TYPE_LATTICE_RELATIONS, pairMatchesDisjoint, normalizeTypeText } = require('./type-lattice');

/**
 * Semantic guards for the hypotheses dream() proposes (#1213).
 *
 * dream() generates from graph shape alone and never consulted the type
 * lattice, so it proposed relationships the system's own semantics already rule
 * out. Both of these reach a human reviewer's queue as `review`, so an
 * impossible hypothesis costs attention, not just cycles.
 *
 * **Disjoint similarity.** `hayvan`/`bitki` is the first entry in the lattice's
 * disjoint table, and a graph where both are siblings under `canli` produced
 * `hayvan --benzer--> bitki` at 0.56 confidence — comfortably above
 * selfEvolve's 0.3 threshold. detectTypeLatticeConflict() exists to answer
 * exactly "can these two both apply", and nothing on this path called it.
 *
 * The check walks ancestors rather than only comparing the two ids, because
 * once a taxonomy has depth the common shape is two *subtypes* whose ancestors
 * are disjoint (`kedi`/`gul`), not two type nodes side by side.
 *
 * **Asymmetric symmetry.** The `simetri` rule proposed the reverse of any edge
 * whose reverse was missing, including `tür`: `hayvan --tür--> kedi` from
 * `kedi --tür--> hayvan`. Committing that makes the two-node `tür` cycle that
 * verify's `döngü` rule reports as a contradiction at 0.7 — the generator
 * proposing what the detector is written to flag. Those particular hypotheses
 * scored 0.27 and fell under the threshold, but by a number, not by any rule
 * about the relation.
 *
 * So symmetry is proposed only for relations that are actually symmetric, as an
 * allowlist: an unrecognised relation is treated as asymmetric, which is the
 * safe default for a generator whose output is a write proposal.
 */

/** Relations for which "a R b" genuinely implies "b R a". */
const SYMMETRIC_RELATIONS = Object.freeze(new Set([
  'benzer',       // similarity, the relation the benzerlik hypotheses propose
  'related_to',   // STANDARD_RELATIONS' undirected link
  'ilişkili',     // its Turkish spelling, used by command input
  'iliskili',     // ...and the ASCII-folded form
  'çelişki',      // a contradicts b iff b contradicts a
  'celiski',
]));

function isSymmetricRelation(relation) {
  return SYMMETRIC_RELATIONS.has(String(relation || '').trim());
}

/** How far a type chain is followed; mirrors collectTypeAncestors' default. */
const MAX_ANCESTOR_DEPTH = 6;

/**
 * Type ancestors of a node, including the node itself, memoised per dream run.
 *
 * Ancestors are walked over the caller's already-indexed out-edges rather than
 * by calling collectTypeAncestors, which re-reads the graph. dream() indexes
 * every node's edges once up front and its own test asserts that
 * (`out-edge reads were not pre-indexed`), so a guard that re-read per node
 * would double the graph reads of a run. The memo then keeps the O(n²)
 * similarity pass from re-walking per pair.
 */
function ancestorsOf(edgesOf, nodeId, cache) {
  const cached = cache.get(nodeId);
  if (cached) return cached;

  const own = normalizeTypeText(nodeId);
  const types = new Set(own ? [own] : []);
  const seen = new Set([nodeId]);
  let frontier = [nodeId];

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && frontier.length > 0; depth += 1) {
    const next = [];
    for (const current of frontier) {
      for (const edge of edgesOf(current) || []) {
        if (!TYPE_LATTICE_RELATIONS.includes(edge.relation)) continue;
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        const type = normalizeTypeText(edge.to);
        if (type) types.add(type);
        next.push(edge.to);
      }
    }
    frontier = next;
  }

  cache.set(nodeId, types);
  return types;
}

/**
 * True when the lattice says these two nodes cannot both apply -- directly, or
 * through any pair of their type ancestors.
 *
 * @param {Function} edgesOf - nodeId => out-edges, from the caller's index
 */
function nodesAreDisjoint(edgesOf, fromId, toId, workspaceId, cache) {
  const fromTypes = ancestorsOf(edgesOf, fromId, cache);
  const toTypes = ancestorsOf(edgesOf, toId, cache);
  for (const left of fromTypes) {
    for (const right of toTypes) {
      if (left === right) continue;
      if (pairMatchesDisjoint(left, right, workspaceId)) return true;
    }
  }
  return false;
}

/**
 * #1643: node-quality gate for hypothesis generation.
 *
 * dream() proposes from graph shape alone, so whatever the ingest produced
 * becomes a hypothesis source. Real-world corpora (markdown tables, CI log
 * lines) yield nodes whose "label" is a table pipe, a bare number, or other
 * punctuation debris; hypotheses sourced from them cost reviewer attention
 * while carrying zero information. A node is eligible as a hypothesis source
 * only when its label carries lexical content: enough length, at least two
 * letters or digits after stripping punctuation/whitespace, and not purely
 * numeric/id-like (job IDs, PR numbers, dates).
 *
 * This is deliberately conservative: it never rejects a label containing
 * letters beyond a trivial minimum, so legitimate short Turkish words
 * ("ağaç") stay eligible while "|" or "---" do not.
 */
const MIN_LABEL_LENGTH = 3;
const MIN_LETTER_CONTENT = 3;
const ID_LIKE = /^[\p{N}\p{P}\p{S}\s]+$/u;

function isEligibleHypothesisNode(label) {
  const s = String(label ?? '').trim();
  if (s.length < MIN_LABEL_LENGTH) return false;
  if (ID_LIKE.test(s)) return false;
  // Letters specifically: "pr | #2" carries two letters wrapped in table
  // debris, while "93172327986" carries none. Digits alone never qualify.
  const letters = s.replace(/[^\p{L}]+/gu, '');
  return letters.length >= MIN_LETTER_CONTENT;
}

module.exports = { SYMMETRIC_RELATIONS, isSymmetricRelation, nodesAreDisjoint, isEligibleHypothesisNode };
