const tr = require('./lang-tr');
const en = require('./lang-en');
const de = require('./lang-de');
const ar = require('./lang-ar');

const PACKS = {
  tr,
  turkish: tr,
  en,
  english: en,
  de,
  german: de,
  deutsch: de,
  ar,
  arabic: ar,
  arabi: ar,
};

// Hoisted out of detectLanguage() so repeated calls don't allocate four new
// Sets each time (#443) -- the word lists never change per call.
const AR_HINTS = new Set(['هو', 'هي', 'كان', 'تكون', 'يكون', 'وال', 'في', 'من', 'إلى', 'على']);
const DE_HINTS = new Set(['der', 'die', 'das', 'ist', 'sind', 'war', 'waren', 'und', 'für', 'mit']);
const EN_HINTS = new Set(['the', 'is', 'are', 'was', 'were', 'and', 'of', 'with', 'for']);
const TR_HINTS = new Set(['ve', 'veya', 'bir', 'için', 'gibi', 'değil', 'dır', 'dir', 'dur', 'dür', 'mi', 'mı']);

function detectLanguage(text) {
  const sample = String(text || '').toLowerCase();
  if (!sample) return 'tr';

  if (/[\u0600-\u06ff]/.test(sample)) return 'ar';
  // German-specific characters (ä, ß) are a strong German signal. Note: ö and
  // ü are shared with Turkish, so they are NOT enough to call a text German.
  if (/[äß]/.test(sample)) return 'de';
  // Turkish-specific characters (ç, ğ, ı, ş) are a strong Turkish signal and
  // must be checked before falling back to shared ö/ü.
  if (/[çğış]/.test(sample)) return 'tr';

  const words = sample
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const hasAny = (set) => words.some(word => set.has(word));

  // Hint-word based detection for texts that only use shared ö/ü (e.g. Turkish
  // "göz", "üzüm") or no special chars at all. Check Turkish before German
  // because Turkish hint words are more distinctive in this codebase's default
  // language.
  if (hasAny(AR_HINTS)) return 'ar';
  if (hasAny(TR_HINTS)) return 'tr';
  if (hasAny(DE_HINTS)) return 'de';
  if (hasAny(EN_HINTS)) return 'en';

  // Last-resort: if the text only contains shared ö/ü (no ä/ß, no ç/ğ/ı/ş,
  // no hint words), default to Turkish because this repo's default language is
  // Turkish and German-only-with-ö/ü-and-no-other-signal is rare here.
  if (/[öü]/.test(sample)) return 'tr';

  return 'tr';
}

function resolvePack(langCode) {
  const key = String(langCode || '').toLowerCase();
  return Object.hasOwn(PACKS, key) ? PACKS[key] : tr;
}

function createAutoPack() {
  const packFor = (text, languageHint = '') => (
    languageHint ? resolvePack(languageHint) : resolvePack(detectLanguage(text))
  );
  return {
    name: 'auto',
    detectLanguage,
    normalize: (word, languageHint = '') => packFor(word, languageHint).normalize(word),
    tokenize: (text, languageHint = '') => packFor(text, languageHint).tokenize(text),
    isStopWord: (word, languageHint = '') => packFor(word, languageHint).isStopWord(word),
    extractFacts: (text, knownNodes = null) => packFor(text).extractFacts(text, knownNodes),
  };
}

module.exports = function createNlp(langCode = 'tr') {
  const key = String(langCode || 'tr').toLowerCase();
  if (key === 'auto') return createAutoPack();
  return resolvePack(key);
};
