const { normalizeText } = require('./text-utils');
const { normalizeAliasText } = require('./adversarial-signals');

const FUZZY_STOPWORDS = Object.freeze([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'the', 'to', 'was', 'were', 'with',
  'bir', 'bu', 'da', 'de', 'ile', 'icin', 'olarak', 've', 'veya', 'mi', 'mı', 'mu', 'mü', 'nedir', 'ne', 'hangi',
]);

function normalizeFuzzyText(input) {
  return normalizeAliasText(input)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeFuzzyText(input) {
  return normalizeFuzzyText(input)
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function isMeaningfulToken(token) {
  if (!token) return false;
  if (/^\d+$/.test(token)) return true;
  if (/^v\d+$/i.test(token)) return true;
  if (/^[a-z]\d+$/i.test(token)) return true;
  if (token.length < 2) return false;
  return !FUZZY_STOPWORDS.includes(token);
}

function meaningfulTokens(input) {
  return tokenizeFuzzyText(input).filter(isMeaningfulToken);
}

function analyzeFuzzyOverlap(left, right, opts = {}) {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const overlap = [...leftSet].filter(token => rightSet.has(token));
  const minOverlap = Number.isFinite(Number(opts.minOverlap)) ? Math.max(1, Number(opts.minOverlap)) : 2;
  const overlapRatio = overlap.length / Math.max(1, Math.min(leftTokens.length || 1, rightTokens.length || 1));

  return {
    left: normalizeFuzzyText(left),
    right: normalizeFuzzyText(right),
    leftTokens,
    rightTokens,
    overlap,
    overlapCount: overlap.length,
    overlapRatio,
    minOverlap,
    isWeak: overlap.length < minOverlap || overlapRatio < 0.5,
  };
}

module.exports = {
  FUZZY_STOPWORDS,
  analyzeFuzzyOverlap,
  isMeaningfulToken,
  meaningfulTokens,
  normalizeFuzzyText,
  tokenizeFuzzyText,
};
