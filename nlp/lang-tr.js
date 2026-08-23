const NORMALIZE_MAP = {
  '\u0131': 'i',
  '\u0130': 'i',
  'I': 'i',
};

const PLURAL_SUFFIXES = ['lar', 'ler'];

const STOP_WORDS = new Set([
  've', 'veya', 'ile', 'de', 'da', 'ki', 'bu', '\u015Fu', 'o', 'bir',
  'i\u00E7in', 'gibi', 'kadar', 'daha', 'en', '\u00E7ok', 'az', 'her', 'hi\u00E7',
  'ne', 'nas\u0131l', 'neden', 'ni\u00E7in', 'nerede', 'kim', 'hangi',
]);

function normalize(word) {
  let w = String(word || '').toLowerCase().trim();
  w = w.replace(/i\u0307/g, 'i').replace(/\u0307/g, '');
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

function extractFacts(text, knownNodes = null) {
  const raw = String(text || '').toLowerCase().trim();
  const words = raw.split(/\s+/).filter(Boolean);
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
