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

function detectLanguage(text) {
  const sample = String(text || '').toLowerCase();
  if (!sample) return 'tr';

  if (/[\u0600-\u06ff]/.test(sample)) return 'ar';
  if (/[äöüß]/.test(sample)) return 'de';
  if (/[çğıöşü]/.test(sample)) return 'tr';

  const words = sample
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const hasAny = (set) => words.some(word => set.has(word));

  const arHints = new Set(['هو', 'هي', 'كان', 'تكون', 'يكون', 'وال', 'في', 'من', 'إلى', 'على']);
  const deHints = new Set(['der', 'die', 'das', 'ist', 'sind', 'war', 'waren', 'und', 'für', 'mit']);
  const enHints = new Set(['the', 'is', 'are', 'was', 'were', 'and', 'of', 'with', 'for']);
  const trHints = new Set(['ve', 'veya', 'bir', 'için', 'gibi', 'değil', 'dır', 'dir', 'dır', 'mi', 'mı']);

  if (hasAny(arHints)) return 'ar';
  if (hasAny(deHints)) return 'de';
  if (hasAny(trHints)) return 'tr';
  if (hasAny(enHints)) return 'en';

  return 'tr';
}

function createAutoPack() {
  const base = tr;
  return {
    name: 'auto',
    detectLanguage,
    normalize: base.normalize,
    tokenize: base.tokenize,
    isStopWord: base.isStopWord,
    extractFacts(text, knownNodes = null) {
      const lang = detectLanguage(text);
      const pack = PACKS[lang] || tr;
      return pack.extractFacts(text, knownNodes);
    },
  };
}

module.exports = function createNlp(langCode = 'tr') {
  const key = String(langCode || 'tr').toLowerCase();
  if (key === 'auto') return createAutoPack();
  return PACKS[key] || tr;
};
