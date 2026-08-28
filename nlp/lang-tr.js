const NORMALIZE_MAP = {
  '\u0131': 'i',
  '\u0130': 'i',
  'I': 'i',
};

const PLURAL_SUFFIXES = ['lar', 'ler'];
const VOWELS = 'ae\u0131io\u00f6u\u00fc';
const VOICELESS = new Set(['p', '\u00e7', 't', 'k', 'f', 'h', 's', '\u015f']);
const FOUR_WAY_HARMONY = Object.freeze({
  a: '\u0131', \u0131: '\u0131', e: 'i', i: 'i', o: 'u', u: 'u', \u00f6: '\u00fc', \u00fc: '\u00fc',
});
const TWO_WAY_HARMONY = Object.freeze({
  a: 'a', \u0131: 'a', e: 'e', i: 'e', o: 'a', u: 'a', \u00f6: 'e', \u00fc: 'e',
});

// Long variants come first so `-den` is not mistaken for `-de`.
const CASE_SUFFIXES = [
  ['nin', 'i', true, 'four'], ['n\u0131n', '\u0131', true, 'four'], ['nun', 'u', true, 'four'], ['n\u00fcn', '\u00fc', true, 'four'],
  ['in', 'i', false, 'four'], ['\u0131n', '\u0131', false, 'four'], ['un', 'u', false, 'four'], ['\u00fcn', '\u00fc', false, 'four'],
  ['dan', 'a', false, 'two', 'ablative'], ['den', 'e', false, 'two', 'ablative'],
  ['tan', 'a', false, 'two', 'ablative'], ['ten', 'e', false, 'two', 'ablative'],
  ['y\u0131', '\u0131', true, 'four'], ['yi', 'i', true, 'four'], ['yu', 'u', true, 'four'], ['y\u00fc', '\u00fc', true, 'four'],
  ['ya', 'a', true, 'two'], ['ye', 'e', true, 'two'],
  ['da', 'a', false, 'two', 'locative'], ['de', 'e', false, 'two', 'locative'],
  ['ta', 'a', false, 'two', 'locative'], ['te', 'e', false, 'two', 'locative'],
  ['\u0131', '\u0131', false, 'four'], ['i', 'i', false, 'four'], ['u', 'u', false, 'four'], ['\u00fc', '\u00fc', false, 'four'],
  ['a', 'a', false, 'two'], ['e', 'e', false, 'two'],
].map(([suffix, vowel, buffered, harmony, series = '']) => ({ suffix, vowel, buffered, harmony, series }))
  .sort((left, right) => right.suffix.length - left.suffix.length);

const CONSONANT_RESTORATION = Object.freeze({ b: 'p', c: '\u00e7', d: 't', g: 'k', '\u011f': 'k' });

const STOP_WORDS = new Set([
  've', 'veya', 'ile', 'de', 'da', 'ki', 'bu', '\u015fu', 'o', 'bir',
  'i\u00e7in', 'gibi', 'kadar', 'daha', 'en', '\u00e7ok', 'az', 'her', 'hi\u00e7',
  'ne', 'nas\u0131l', 'neden', 'ni\u00e7in', 'nerede', 'kim', 'hangi',
]);

function lastVowelOf(word) {
  for (let index = word.length - 1; index >= 0; index -= 1) {
    if (VOWELS.includes(word[index])) return word[index];
  }
  return null;
}

function restoreInflectedStem(stem, suffix) {
  // Turkish voicing alternation is relevant before a vowel-initial suffix;
  // do not rewrite foreign words such as `webde` on consonant-initial cases.
  if (!VOWELS.includes(suffix[0])) return stem;
  const final = stem[stem.length - 1];
  return CONSONANT_RESTORATION[final]
    ? `${stem.slice(0, -1)}${CONSONANT_RESTORATION[final]}`
    : stem;
}

function stripCaseSuffix(word) {
  const hasLongerSuffix = CASE_SUFFIXES.some(candidate => candidate.suffix.length > 1 && word.endsWith(candidate.suffix));
  for (const candidate of CASE_SUFFIXES) {
    if (!word.endsWith(candidate.suffix)) continue;
    if (candidate.suffix.length === 1 && hasLongerSuffix) continue;
    const stem = word.slice(0, -candidate.suffix.length);
    // A one-vowel ending is too ambiguous to remove from short words:
    // `araba` and `hata` are base forms, not `arab-a`/`hat-a`. Buffered
    // forms (`kediyi`, `kediye`) and longer endings remain available.
    const minimumLength = candidate.suffix.length === 1
      ? (candidate.harmony === 'four' ? 4 : 5)
      : 3;
    if (stem.length < minimumLength) continue;

    const final = stem[stem.length - 1];
    if (candidate.buffered && !VOWELS.includes(final)) continue;
    // An unbuffered genitive ending follows a consonant; accepting it after
    // a vowel would make a base word ending in `i` look inflected. Dative,
    // locative, and ablative may follow either kind of stem.
    if (!candidate.buffered && candidate.harmony === 'four' && VOWELS.includes(final)) continue;
    const lastVowel = lastVowelOf(stem);
    const harmony = candidate.harmony === 'four' ? FOUR_WAY_HARMONY : TWO_WAY_HARMONY;
    // The normalizer folds dotless `ı` to `i` for case-insensitive lookup. In
    // two-way harmony that folded vowel may therefore represent back `ı`, so
    // both `a` and `e` are retained as possible surface endings until other
    // guards (stem length and alternation) decide whether stripping is safe.
    const harmonyMatches = lastVowel && (
      harmony[lastVowel] === candidate.vowel
      || (candidate.harmony === 'two' && lastVowel === 'i' && candidate.vowel === 'a')
    );
    if (!harmonyMatches) continue;
    if (candidate.series && candidate.suffix[0] !== (VOICELESS.has(final) ? 't' : 'd')) continue;

    const restored = restoreInflectedStem(stem, candidate.suffix);
    const followsPlural = PLURAL_SUFFIXES.some(suf => stem.endsWith(suf) && stem.length > suf.length + 2);
    // Two-way, unbuffered endings need visible consonant alternation; this
    // rejects base `araba` while accepting long `kitaba` -> `kitap`.
    if (candidate.suffix.length === 1 && restored === stem && !followsPlural) continue;
    return restored;
  }
  return word;
}

function normalize(word) {
  let w = String(word || '').toLowerCase().trim();
  // Ingest-side node hygiene (#1643 follow-up): markdown/JSON debris reaches
  // learn() as whitespace tokens ("{", "[],", "true,"). Only the Turkish pack
  // keeps punctuation through normalize (en/de/ar whitelist to letters), so
  // those tokens were turning into graph nodes verbatim. Trim edge
  // punctuation; interior punctuation stays ("curl.exe", "agent-card/x").
  w = w.replace(/^[^\p{L}\p{N}_]+/u, '').replace(/[^\p{L}\p{N}_]+$/u, '');
  if (!w) return '';
  w = w.replace(/i\u0307/g, 'i').replace(/\u0307/g, '');
  // Case morphology belongs to a token, not to the final characters of a
  // multi-word subject or predicate (`gizli kedi` must stay `gizli kedi`).
  // Preserve the historical basic fold for each token without stripping case.
  if (/\s/.test(w)) {
    return w.split(/\s+/).map(token => token.split('').map(c => NORMALIZE_MAP[c] || c).join('')).join(' ');
  }
  // Canonical entity identifiers are not Turkish words; never turn the final
  // `ce` of `artificial_intelligence` into a Turkish case/consonant rewrite.
  if (/[\d_]/.test(w)) return w;
  // Keep Turkish vowel distinctions until case morphology has been checked.
  w = stripCaseSuffix(w);
  w = w.split('').map(c => NORMALIZE_MAP[c] || c).join('');
  for (const suf of PLURAL_SUFFIXES) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      w = w.slice(0, w.length - suf.length);
      break;
    }
  }
  return w;
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

function hasLexicalContent(token) {
  // A token with no letter or digit anywhere ("{", "---", "\"\"\"") carries no
  // concept and must never become a node or part of one (#1643 follow-up).
  return /[\p{L}\p{N}]/u.test(token);
}

function extractFacts(text, knownNodes = null) {
  const raw = String(text || '').toLowerCase().trim();
  const words = raw.split(/\s+/).filter(hasLexicalContent);
  if (words.length < 2) return [];

  const filtered = words.filter(w => w !== 'bir' && w !== 'de' && w !== 'da');
  if (filtered.length < 2) return [];

  const veIdx = filtered.indexOf('ve');
  if (veIdx === 1 && filtered.length >= 4) {
    const subjectA = normalize(filtered[0]);
    const subjectB = normalize(filtered[2]);
    const predicate = filtered.slice(3).join(' ');
    return [
      { subject: subjectA, predicate },
      { subject: subjectB, predicate },
    ];
  }

  const article = words.indexOf('bir');
  if (article > 0 && article < words.length - 1) {
    const subject = normalize(words.slice(0, article).join(' '));
    const predicate = words.slice(article + 1).filter(w => w !== 'de' && w !== 'da').join(' ');
    return subject && predicate ? [{ subject, predicate }] : [];
  }

  if (knownNodes) {
    const nodeIds = typeof knownNodes === 'object' && !Array.isArray(knownNodes)
      ? Object.keys(knownNodes)
      : (Array.isArray(knownNodes) ? knownNodes : []);

    for (let len = Math.min(3, filtered.length - 1); len >= 2; len--) {
      const candidate = normalize(filtered.slice(0, len).join(' '));
      if (nodeIds.includes(candidate) || nodeIds.some(n => normalize(n) === candidate)) {
        const predicate = filtered.slice(len).join(' ');
        return [{ subject: candidate, predicate }];
      }
    }
  }

  const subject = normalize(filtered[0]);
  const predicate = filtered.slice(1).join(' ');
  return [{ subject, predicate }];
}

module.exports = {
  name: 'turkish',
  normalize,
  tokenize,
  isStopWord,
  extractFacts,
};
