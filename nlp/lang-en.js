const normalizePhrase = require('./normalize-phrase');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
]);

// Concepts whose trailing `s`/`es` belongs to the word, not to an inflection.
// No rule separates them from a real plural -- `series` and `plates` have the
// same shape -- so they are listed. Without this, `learn:` sealed a corrupted
// node identity into the graph (`kubernetes` -> `kubernet`) that no later
// ask/verify/search could find (#3899). Growing this list is the intended
// seam; every entry is a concept a user may teach verbatim.
const UNINFLECTED = new Set([
  'kubernetes', 'series', 'species', 'https', 'news', 'analytics', 'devops',
  'jenkins', 'postgres', 'pandas', 'keras', 'centos', 'macos', 'nodejs',
  'grafana', 'prometheus', 'kafka', 'nginx', 'terraform', 'ansible', 'splunk',
]);

// Root endings that are never plural markers, so the `s` stays: `class`,
// `process` (-ss), `status`, `virus` (-us), `redis`, `analysis` (-is). The
// old code stripped the `s` off every one of them (#3899).
const S_ROOT_ENDINGS = /(?:ss|us|is)$/;

// A real `-es` plural follows a sibilant: boxes, buses, watches, dishes.
// Elsewhere the `s` is the whole suffix, so only it is dropped
// (notes -> note, cafes -> cafe) instead of the old `es` (notes -> not).
const SIBILANT_ES_ENDING = /(?:[sxz]|ch|sh)es$/;

function stripInflection(w) {
  // Length guards are the historical `w.length > suffix.length + 2`: they
  // keep `king`, `red` and `bus` intact.
  if (w.endsWith('ing') && w.length >= 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length >= 5) return w.slice(0, -2);
  if (w.endsWith('s') && w.length >= 4) {
    if (UNINFLECTED.has(w) || S_ROOT_ENDINGS.test(w)) return w;
    if (SIBILANT_ES_ENDING.test(w)) return w.slice(0, -2);
    return w.slice(0, -1);
  }
  return w;
}

function normalize(word) {
  let w = String(word || '').toLowerCase().trim();
  // NFKD + strip diacritics turns accented Latin letters into their base
  // form (café -> cafe) before the ASCII filter runs, instead of the filter
  // silently deleting the accented letter outright (café -> caf, #443).
  w = w.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
  w = w.replace(/[^a-z0-9-]/g, '');
  return stripInflection(w);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isStopWord(word) {
  return STOP_WORDS.has(normalize(word));
}

function extractFacts(text) {
  const rawTokens = tokenize(text);
  if (rawTokens.length < 2) return [];

  const andIdx = rawTokens.indexOf('and');
  if (andIdx === 1 && rawTokens.length >= 4) {
    const subjectA = normalize(rawTokens[0]);
    const subjectB = normalize(rawTokens[2]);
    const predicate = rawTokens.slice(3).filter(t => !isStopWord(t)).join(' ');
    return [
      { subject: subjectA, predicate },
      { subject: subjectB, predicate },
    ];
  }

  // The copula is located on rawTokens, before stop-words are dropped.
  //
  // This search used to run on the filtered list, but 'is', 'are', 'was' and
  // 'were' are themselves in STOP_WORDS — so the copula was never present,
  // findIndex always returned -1, and the whole branch was dead. Every sentence
  // fell to the final fallback, which takes "the first non-stop-word" as the
  // subject: "the big cat is a small animal" yielded subject `big`, predicate
  // `cat small animal`. Single-word subjects came out right by coincidence.
  //
  // extractFacts runs on the kernel.learn() path and its subject becomes the
  // graph node's identity, so a wrong subject is a node no later ask/verify/
  // reason query can find. lang-de.js and lang-ar.js already search rawTokens
  // this way; only the English pack had the order inverted (#1037).
  const copulaIdx = rawTokens.findIndex(t => ['is', 'are', 'was', 'were'].includes(t));
  if (copulaIdx > 0) {
    const subject = normalizePhrase(rawTokens.slice(0, copulaIdx), normalize, isStopWord);
    const predicate = rawTokens.slice(copulaIdx + 1).filter(t => !isStopWord(t)).join(' ');
    if (subject && predicate) {
      return [{ subject, predicate }];
    }
  }

  const tokens = rawTokens.filter(t => !isStopWord(t));
  if (tokens.length < 2) return [];

  return [{
    subject: normalize(tokens[0]),
    predicate: tokens.slice(1).join(' '),
  }];
}

module.exports = {
  name: 'english',
  normalize,
  tokenize,
  isStopWord,
  extractFacts,
};
