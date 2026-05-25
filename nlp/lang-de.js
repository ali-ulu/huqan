const STOP_WORDS = new Set([
  'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'ist', 'sind', 'war', 'waren',
  'zu', 'von', 'mit', 'für', 'auf', 'im', 'in', 'am', 'an',
]);

function normalize(word) {
  let w = String(word || '').toLowerCase().trim();
  w = w.replace(/[^a-z0-9äöüß-]/g, '');
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

  const andIdx = rawTokens.indexOf('und');
  if (andIdx === 1 && rawTokens.length >= 4) {
    const subjectA = normalize(rawTokens[0]);
    const subjectB = normalize(rawTokens[2]);
    const predicate = rawTokens.slice(3).filter(t => !isStopWord(t)).join(' ');
    return [
      { subject: subjectA, predicate },
      { subject: subjectB, predicate },
    ];
  }

  const copulaIdx = rawTokens.findIndex(t => ['ist', 'sind', 'war', 'waren'].includes(t));
  if (copulaIdx > 0) {
    const subject = normalize(rawTokens.slice(0, copulaIdx).join(' '));
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
  name: 'german',
  normalize,
  tokenize,
  isStopWord,
  extractFacts,
};
