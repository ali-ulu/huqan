'use strict';

// Turkish text-surface matching for verification (#2213).
//
// Moved verbatim from lib/verify-native.js: phrase and morphology matching
// over Turkish (and mixed English/Turkish) claim text. Pure functions over
// strings and the suffix tables below; the only external needs are the
// copula splitter and the text normalizer. Nothing here reads the graph,
// the kernel, or process state.

const { stripCopulaOrKeep } = require('./turkish-copula');
const { normalizeText } = require('./text-utils');

function foldTurkishAscii(value = '') {
  return String(value || '')
    .replace(/[ıİ]/g, 'i')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u')
    .replace(/[şŞ]/g, 's')
    .replace(/[öÖ]/g, 'o')
    .replace(/[çÇ]/g, 'c');
}

/**
 * Strips the copula from the final word, where a Turkish predicate noun sits.
 *
 * Matching on the ending alone collapsed distinct words onto one token --
 * `kültür` and `kül` both became `kul`, `müdür` and `mü` both became `mu`, and
 * `tür` became the empty string -- so two unrelated claims compared equal
 * through `phraseMatches` and `hasSharedSemanticAnchor` (#1106). `stripCopula`
 * refuses those, leaving the word intact.
 */
function stripCopulaSuffix(value = '') {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return '';
  const lastIndex = words.length - 1;
  words[lastIndex] = stripCopulaOrKeep(words[lastIndex]);
  return words.filter(Boolean).join(' ');
}

function sharedPrefixLength(left = '', right = '') {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

const TURKISH_INFLECTION_SUFFIXES = new Set([
  'a', 'e', 'ı', 'i', 'u', 'ü', 'da', 'de', 'ta', 'te', 'ya', 'ye', 'yı', 'yi', 'yu', 'yü',
  'dan', 'den', 'tan', 'ten', 'lar', 'ler', 'ın', 'in', 'un', 'ün', 'nın', 'nin', 'nun', 'nün',
  'dır', 'dir', 'dur', 'dür', 'tır', 'tir', 'tur', 'tür',
]);
const TURKISH_PRIVATIVE_SUFFIXES = new Set(['sız', 'siz', 'suz', 'süz']);
const TURKISH_SEMANTIC_TAILS = new Set([
  'li', 'lı', 'lu', 'lü', 'ci', 'cı', 'cu', 'cü', 'gi', 'gı', 'gu', 'gü', 'ki', 'kı', 'ku', 'kü',
]);
const TURKISH_CONSONANT_ALTERNATIONS = new Set(['kg', 'gk', 'dt', 'td', 'bp', 'pb', 'çc', 'cc']);
const PREDICATE_WRAPPER_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'being', 'been',
  'bir', 'bu', 'şu', 'o', 'mi', 'mı', 'mu', 'mü', 'causes', 'cause', 'leads', 'lead', 'to', 'triggers', 'trigger',
  'prevents', 'prevent', 'blocks', 'stops', 'reduces', 'inhibits', 'enables', 'enable',
  'depends', 'on', 'neden', 'olur', 'yol', 'açar', 'sebep', 'tetikler', 'önler', 'onler', 'engeller',
  'durdurur', 'sağlar', 'mümkün', 'kılar', 'olanak', 'verir', 'etkinleştirir', 'bağlı',
  'gerektirir', 'dayanır', 'olmadan', 'yapar', 'yapabilir',
]);

function containsWholePhrase(haystack, needle) {
  if (haystack === needle) return true;
  const haystackWords = haystack.split(/\s+/).filter(Boolean);
  const needleWords = needle.split(/\s+/).filter(Boolean);
  if (needleWords.length === 0 || haystackWords.length < needleWords.length) return false;
  for (let start = 0; start <= haystackWords.length - needleWords.length; start += 1) {
    if (needleWords.every((word, index) => haystackWords[start + index] === word)) {
      const outside = [...haystackWords.slice(0, start), ...haystackWords.slice(start + needleWords.length)];
      if (outside.every(word => PREDICATE_WRAPPER_WORDS.has(word))) return true;
    }
  }
  return false;
}

function isAllowedTurkishInflection(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b || a.includes(' ') || b.includes(' ')) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 5 || !longer.startsWith(shorter)) return false;
  const suffix = longer.slice(shorter.length);
  return suffix.length > 0
    && suffix.length <= 4
    && !TURKISH_PRIVATIVE_SUFFIXES.has(suffix)
    && (TURKISH_INFLECTION_SUFFIXES.has(suffix) || TURKISH_SEMANTIC_TAILS.has(suffix))
    && sharedPrefixLength(shorter, longer) >= 5;
}

function hasPlausibleSemanticPrefix(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b || a.includes(' ') || b.includes(' ')) return false;
  const prefix = sharedPrefixLength(a, b);
  if (prefix < 5 || Math.abs(a.length - b.length) > 4) return false;
  const tails = [a.slice(prefix), b.slice(prefix)];
  if (tails.every(tail => !tail || TURKISH_SEMANTIC_TAILS.has(tail) || TURKISH_INFLECTION_SUFFIXES.has(tail))) return true;
  if (prefix >= 5 && a[prefix] && b[prefix] && TURKISH_CONSONANT_ALTERNATIONS.has(a[prefix] + b[prefix])) {
    const alternatedTails = [a.slice(prefix + 1), b.slice(prefix + 1)];
    return alternatedTails.every(tail => !tail || TURKISH_SEMANTIC_TAILS.has(tail) || TURKISH_INFLECTION_SUFFIXES.has(tail));
  }
  return false;
}

function hasAllowedWrappedWord(haystack, needle) {
  const words = normalizeText(haystack).split(/\s+/).filter(Boolean);
  const target = normalizeText(needle);
  if (!target || target.includes(' ')) return false;
  return words.some((word, index) => {
    if (word !== target && !isAllowedTurkishInflection(word, target)) return false;
    return words.every((outside, outsideIndex) => outsideIndex === index || PREDICATE_WRAPPER_WORDS.has(outside));
  });
}

function phraseMatches(left = '', right = '') {
  if (!left || !right) return false;
  if (left === right) return true;
  if (containsWholePhrase(left, right) || hasAllowedWrappedWord(left, right)) return true;
  return isAllowedTurkishInflection(left, right);
}

function hasSharedSemanticAnchor(left = '', right = '') {
  if (!left || !right) return false;
  if (phraseMatches(left, right) || phraseMatches(right, left)) return true;
  const leftTokens = normalizeText(left).split(/\s+/).filter(token => token.length >= 4);
  const rightTokens = normalizeText(right).split(/\s+/).filter(token => token.length >= 4);
  return leftTokens.some(a => rightTokens.some(b => (
    a === b || isAllowedTurkishInflection(a, b) || hasPlausibleSemanticPrefix(a, b)
  )));
}

function isPreventRelation(relation = '') {
  const normalized = normalizeText(relation);
  return ['prevents', 'prevent', 'blocks', 'stops', 'reduces', 'inhibits', 'onler', 'önler', 'engeller', 'azaltir', 'azaltır'].includes(normalized);
}

function normalizeNegationTarget(value) {
  return String(value || '')
    .replace(/\s*\[değil\]\s*$/i, '')
    // Both spellings: callers pass raw targets ("hayvan [değil]") and
    // normalizeForVerify-folded ones ("hayvan degil"). Only the diacritic form
    // was listed, so a folded copula negation kept its `degil` tail and never
    // matched the affirmative predicate "hayvan" (#3912 review).
    .replace(/(?:degildir|degil|değildir|değil|yabilir|yebilir|abilir|ebilir|yamaz|yemez|amaz|emez|maz|mez)$/i, '')
    .trim();
}

function normalizeForVerify(kernel, value = '') {
  const rawWords = String(value || '').trim().split(/\s+/).filter(Boolean);
  const normalized = rawWords.map(word => {
    // Two anchored trims rather than one alternation: equivalent output with
    // no nested-quantifier shape for polynomial backtracking (CodeQL).
    const token = word.replace(/^[^\p{L}\p{N}_-]+/gu, '').replace(/[^\p{L}\p{N}_-]+$/gu, '');
    return typeof kernel?.normalizeWord === 'function' ? kernel.normalizeWord(token) : normalizeText(token);
  }).filter(Boolean).join(' ');
  return stripCopulaSuffix(foldTurkishAscii(normalized));
}

module.exports = {
  foldTurkishAscii,
  stripCopulaSuffix,
  sharedPrefixLength,
  containsWholePhrase,
  isAllowedTurkishInflection,
  hasPlausibleSemanticPrefix,
  hasAllowedWrappedWord,
  phraseMatches,
  hasSharedSemanticAnchor,
  isPreventRelation,
  normalizeNegationTarget,
  normalizeForVerify,
};
