const normalizePhrase = require('./normalize-phrase');

const STOP_WORDS = new Set([
  'ال', 'و', 'أو', 'في', 'على', 'من', 'إلى', 'الى', 'عن', 'مع', 'هذا', 'هذه',
  'هو', 'هي', 'هم', 'هن', 'كان', 'تكون', 'يكون',
]);

function normalize(word) {
  let w = String(word || '').toLowerCase().trim();
  w = w.replace(/[^\u0600-\u06ff0-9-]/g, '');
  w = w.replace(/^ال+/u, '');
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

  const andIdx = rawTokens.indexOf('و');
  if (andIdx === 1 && rawTokens.length >= 4) {
    const subjectA = normalize(rawTokens[0]);
    const subjectB = normalize(rawTokens[2]);
    const predicate = rawTokens.slice(3).filter(t => !isStopWord(t)).join(' ');
    return [
      { subject: subjectA, predicate },
      { subject: subjectB, predicate },
    ];
  }

  if (rawTokens.length >= 4 && rawTokens[1].startsWith('و')) {
    const copulaIdx = rawTokens.findIndex(t => ['هو', 'هي', 'هم', 'هن', 'يكون', 'تكون', 'كان'].includes(t));
    if (copulaIdx === 2) {
      const subjectA = normalize(rawTokens[0]);
      const subjectB = normalize(rawTokens[1].slice(1));
      const predicate = rawTokens.slice(copulaIdx + 1).filter(t => !isStopWord(t)).join(' ');
      return [
        { subject: subjectA, predicate },
        { subject: subjectB, predicate },
      ];
    }
  }

  const copulaIdx = rawTokens.findIndex(t => ['هو', 'هي', 'هم', 'هن', 'يكون', 'تكون', 'كان'].includes(t));
  if (copulaIdx > 0) {
    const subject = normalizePhrase(rawTokens.slice(0, copulaIdx), normalize, isStopWord);
    const predicate = rawTokens.slice(copulaIdx + 1).filter(t => !isStopWord(t)).join(' ');
    if (subject && predicate) return [{ subject, predicate }];
  }

  const tokens = rawTokens.filter(t => !isStopWord(t));
  if (tokens.length < 2) return [];
  return [{
    subject: normalize(tokens[0]),
    predicate: tokens.slice(1).join(' '),
  }];
}

module.exports = {
  name: 'arabic',
  normalize,
  tokenize,
  isStopWord,
  extractFacts,
};
