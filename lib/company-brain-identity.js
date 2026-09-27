'use strict';

// Node identity and query tokenization for company-brain (#2924 review).
//
// These four helpers all answer the same question -- what makes two pieces of
// text the same or different -- and they used to live in the plugin beside the
// ingest logic. They are split out for two reasons. The plugin sits at its
// recorded line ceiling, so new code belongs in a module of its own; and the
// bugs fixed here were all identity bugs, so keeping the whole identity policy
// in one file makes the next instance easier to see.

const crypto = require('crypto');
const { normalizeAlias } = require('./entity-resolution');

/**
 * Readable, lossy label for a node id. Never an identity on its own -- see
 * `identityKey`.
 *
 * Turkish-aware lowercasing matters here: plain `.toLowerCase()` maps `İ`
 * (U+0130) to `i` + U+0307, and the combining dot is outside the allowed class,
 * so every `İ` split its word in two ("ÜRÜN İADE POLİTİKASI" became
 * "ürün-i-ade-poli-ti-kasi"). NFC keeps ç/ğ/ö/ş/ü composed -- NFKD would strip
 * them to bare ASCII, which is a different and unwanted change -- and any
 * combining mark that still survives is removed rather than turned into a
 * separator.
 */
function slug(text) {
  return String(text || '')
    .normalize('NFC')
    .toLocaleLowerCase('tr')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9çğıöşü]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'decision';
}

/**
 * Identity for a company-brain node: the readable slug plus a digest over the
 * *whole* input.
 *
 * The slug alone was the distinguishing part of these ids, and it truncates at
 * 48 characters. Two decisions on the same date whose titles diverged after
 * character 48 collapsed onto one node -- silently, both calls returning
 * ok:true -- so two contradictory policies ended up filed as evidence for the
 * same decision, and contradiction detection could not see a conflict because
 * the graph held only one. `manual-note` was worse: it keyed on the first 24
 * characters of the note text.
 *
 * @param {...string} parts Everything that makes this node distinct.
 * @returns {string}
 */
function identityKey(...parts) {
  const label = slug(parts[0]);
  // JSON-encoding the parts keeps the field boundary unambiguous, so
  // ('ab', 'c') and ('a', 'bc') cannot hash alike.
  const digest = crypto.createHash('sha256').update(JSON.stringify(parts.map(part => String(part ?? ''))), 'utf8').digest('hex').slice(0, 12);
  return `${label}-${digest}`;
}

/**
 * Stable node id for content that parsed no predicate.
 *
 * The fallback target used to be `text.slice(0, 96)`, so the raw note became a
 * node id and two notes that agreed for 96 characters and diverged after it
 * collapsed onto one node -- silently, both ingests returning ok:true. That is
 * the same collision `identityKey` was introduced to end for `manual-note` and
 * `decision`; the fallback and the API path were the two call sites left on
 * the truncated-raw-text scheme. The readable prefix is kept for the operator,
 * the digest over the whole text is what distinguishes.
 */
function fallbackTargetId(text, kind = 'note') {
  return `${kind}:${identityKey(text)}`;
}

/**
 * Query tokens for graph matching, deduplicated and length-filtered.
 *
 * Folding through `normalizeAlias` is the point: plain `.toLowerCase()` maps
 * `İ` (U+0130) to `i` + U+0307, and the combining dot is a separator under the
 * token split below. A query for "İADE" therefore tokenized to "ade", which
 * substring-matched the unrelated node "kademe" and returned it as graph
 * evidence. Folding the query the same way node labels are folded keeps the
 * two spellings of one word together instead of inventing a fragment.
 */
function extractTokens(text) {
  return normalizeAlias(String(text || ''))
    .split(/[^a-z0-9_:/.-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 3);
}

module.exports = { slug, identityKey, fallbackTargetId, extractTokens };
