const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
]);

function normalize(word) {
  let w = String(word || '').toLowerCase().trim();
  // NFKD + strip diacritics turns accented Latin letters into their base
  // form (café -> cafe) before the ASCII filter runs, instead of the filter
  // silently deleting the accented letter outright (café -> caf, #443).
  w = w.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
  w = w.replace(/[^a-z0-9-]/g, '');
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      w = w.slice(0, -suf.length);
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

  const tokens = rawTokens.filter(t => !isStopWord(t));
  if (tokens.length < 2) return [];

  const isIdx = tokens.findIndex(t => ['is', 'are', 'was', 'were'].includes(t));
  if (isIdx > 0) {
    const subject = normalize(tokens.slice(0, isIdx).join(' '));
    const predicate = tokens.slice(isIdx + 1).join(' ');
    if (subject && predicate) {
      return [{ subject, predicate }];
    }
  }

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
