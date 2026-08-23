'use strict';

/**
 * Guarded removal of the Turkish copula `-dır` from a word.
 *
 * Four call sites used to strip it by spelling alone -- `s.replace(/(dir|dur|
 * tir|tur|dır|dür|tır|tür)$/i, '')` -- and Turkish has many ordinary words that
 * simply end in those three letters. Every one of them was truncated, and
 * several landed on a *different real word*: `kültür` (culture) became `kül`
 * (ash), `müdür` (manager) became `mü`, and `tür` (type) became the empty
 * string -- an edge pointing at nothing (#1106, #1167, #1195).
 *
 * The fix does not need a dictionary, because Turkish already constrains which
 * copula a given stem may take. Two rules decide it, and a real copula obeys
 * both:
 *
 *   consonant assimilation -- `t` after a voiceless consonant (p ç t k f h s ş),
 *   `d` everywhere else. `kitap` takes `-tır`, `doktor` takes `-dur`.
 *
 *   vowel harmony -- the suffix vowel follows the stem's last vowel:
 *   a/ı -> ı, e/i -> i, o/u -> u, ö/ü -> ü. `sıcak` takes `-tır`, never `-tur`.
 *
 * So `kültür` is refused because the stem `kül` ends in `l`, which is voiced and
 * requires `-dür`; the word spells `tür`, so the `tür` here is not a copula. The
 * same test admits `müdürdür` -> `müdür` and refuses bare `müdür`, where the
 * would-be stem `mü` is below the minimum length.
 *
 * Callers get `null` for "this is not a copula", never a mangled stem, so the
 * failure mode is a missed normalization rather than a corrupted fact.
 */

const VOICELESS = new Set(['p', 'ç', 't', 'k', 'f', 'h', 's', 'ş']);

const VOWEL_HARMONY = Object.freeze({
  a: 'ı', ı: 'ı', e: 'i', i: 'i', o: 'u', u: 'u', ö: 'ü', ü: 'ü',
});

const VOWELS = 'aeıioöuü';

/**
 * Shortest stem a copula may leave behind.
 *
 * Two-letter leftovers are the signature of a false strip: `mü` from `müdür`,
 * `na` from `nadir`, `ka` from `kadir`, `ça` from `çadır`.
 *
 * This is the one guard here that is a judgement call rather than a rule of the
 * language, and it is not free: Turkish does have two-letter nouns, so `sudur`
 * ("it is water"), `evdir` and `aydır` carry a real copula and are left
 * unstripped. Lowering the bound to two would recover them and reintroduce
 * `müdür -> mü` and `çadır -> ça`, which vowel harmony alone does not catch.
 *
 * Three is chosen because the two failures are not symmetric. A missed strip
 * means a claim fails to match a stored fact -- the system says "I don't know"
 * about something it knows. A false strip writes a graph node under a word the
 * user never used, permanently, and sometimes that word is a different real
 * concept. Between silence and a fabricated fact, this module chooses silence.
 */
const MIN_STEM_LENGTH = 3;

const COPULA_PATTERN = /(d|t)([ıiuü])r$/i;

/**
 * Some call sites fold Turkish letters to ASCII before normalizing, which
 * erases the ı/i and ü/u distinctions that harmony depends on. Comparing both
 * the expected and the observed suffix vowel *through the same fold* keeps the
 * check meaningful on folded text (it still separates the front/back pairs that
 * survive) instead of rejecting every folded word outright.
 *
 * `ç` folds to `c`, so a folded `c` could be either the voiceless `ç` or the
 * voiced `c`. That one letter is treated as undecidable and skips the
 * assimilation test rather than guessing.
 */
function foldForComparison(value) {
  return String(value).replace(/ı/g, 'i').replace(/ü/g, 'u');
}

function lastVowelOf(stem) {
  for (let i = stem.length - 1; i >= 0; i -= 1) {
    if (VOWELS.includes(stem[i])) return stem[i];
  }
  return null;
}

/**
 * Returns the stem with the copula removed, or `null` when the ending is not a
 * copula this word could actually take.
 */
function stripCopula(word) {
  const text = String(word || '').toLowerCase();
  const match = COPULA_PATTERN.exec(text);
  if (!match) return null;

  const stem = text.slice(0, -3);
  if (stem.length < MIN_STEM_LENGTH) return null;

  const finalLetter = stem[stem.length - 1];
  const ambiguousAfterFolding = finalLetter === 'c';
  if (!ambiguousAfterFolding) {
    const requiresT = VOICELESS.has(finalLetter);
    if (requiresT !== (match[1].toLowerCase() === 't')) return null;
  }

  const lastVowel = lastVowelOf(stem);
  if (!lastVowel) return null;
  if (foldForComparison(VOWEL_HARMONY[lastVowel]) !== foldForComparison(match[2].toLowerCase())) {
    return null;
  }

  return stem;
}

/** Convenience for callers that want the word back unchanged on refusal. */
function stripCopulaOrKeep(word) {
  const stem = stripCopula(word);
  return stem === null ? String(word || '') : stem;
}

/** True when the word ends in a copula this stem could actually take. */
function hasCopula(word) {
  return stripCopula(word) !== null;
}

module.exports = {
  MIN_STEM_LENGTH,
  hasCopula,
  stripCopula,
  stripCopulaOrKeep,
};
