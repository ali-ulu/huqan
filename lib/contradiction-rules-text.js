// #2178: text helpers shared by the detectors -- tokens, phrase matching,
// subject stripping, comparable numbers, same-subject check, signal shape.

const { normalizeText } = require('./text-utils');

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function asText(value) {
  return normalizeText(value);
}

function textTokens(value) {
  return asText(value)
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function hasAnyToken(text, tokens) {
  // Tokenize on whitespace and punctuation, then exact-match against the
  // token set. Substring matching (e.g. "no" inside "snow" / "knowledge")
  // produces false positives, so we do not use String.includes here.
  const haystackTokens = new Set(
    String(asText(text) || '')
      .toLowerCase()
      .split(/[\s,.!?;:"'()[\]{}]+/u)
      .filter(Boolean)
  );
  return tokens.some((token) => haystackTokens.has(String(asText(token) || '').toLowerCase()));
}

function hasAnyPhrase(text, phrases) {
  const haystack = asText(text);
  return phrases.some((phrase) => {
    const needle = asText(phrase);
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryLeft = '(?<![\\p{L}\\p{N}])';
    const boundaryRight = '(?![\\p{L}\\p{N}])';
    return new RegExp(`${boundaryLeft}${escaped}${boundaryRight}`, 'u').test(haystack);
  });
}

function collectSignal(rule, detail, evidence, opts = {}) {
  return {
    rule,
    kind: 'contradiction',
    severity: clamp01(opts.severity ?? 0.8, 0.8),
    confidence: clamp01(opts.confidence ?? 0.9, 0.9),
    flags: Array.isArray(opts.flags) ? [...new Set([rule, ...opts.flags])] : [rule],
    detail,
    evidence: Array.isArray(evidence) ? evidence : [],
    meta: {
      ...((opts.meta && typeof opts.meta === 'object') ? opts.meta : {}),
    },
  };
}

function extractTextParts(stored, incoming) {
  return {
    storedText: asText(stored?.text || stored?.statement || stored?.claim || stored || ''),
    incomingText: asText(incoming?.text || incoming?.statement || incoming?.claim || incoming || ''),
    storedSubject: asText(stored?.subject || stored?.from || stored?.entity || stored?.node || stored?.target || ''),
    incomingSubject: asText(incoming?.subject || incoming?.from || incoming?.entity || incoming?.node || incoming?.target || ''),
    storedObject: asText(stored?.object || stored?.to || stored?.value || stored?.predicate || ''),
    incomingObject: asText(incoming?.object || incoming?.to || incoming?.value || incoming?.predicate || ''),
    storedRelation: asText(stored?.relation || stored?.verb || stored?.predicate || ''),
    incomingRelation: asText(incoming?.relation || incoming?.verb || incoming?.predicate || ''),
  };
}

function stripSubject(text, subject) {
  const rawText = asText(text);
  const rawSubject = asText(subject);
  if (!rawText || !rawSubject) return rawText;
  // Use Unicode-aware word boundaries. The built-in \b anchor is ASCII-only
  // and does not treat Turkish letters (ç, ğ, ı, ş, ü, ö) as word characters,
  // so "güneş" would not be matched inside "güneşin". Use lookarounds that
  // treat any Unicode letter or digit as a word char via \p{L} and \p{N}.
  const escaped = rawSubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryLeft = '(?<![\\p{L}\\p{N}])';
  const boundaryRight = '(?![\\p{L}\\p{N}])';
  return rawText.replace(new RegExp(`${boundaryLeft}${escaped}${boundaryRight}`, 'gu'), ' ').replace(/\s+/g, ' ').trim();
}

function extractComparableNumbers(text, subject) {
  const stripped = stripSubject(text, subject);
  return stripped.match(/-?\d+(?:[.,]\d+)?/g) || [];
}

function sameSubject(stored, incoming) {
  const parts = extractTextParts(stored, incoming);
  if (parts.storedSubject && parts.incomingSubject) {
    return parts.storedSubject === parts.incomingSubject;
  }
  const storedText = parts.storedText;
  const incomingText = parts.incomingText;
  const firstStored = storedText.split(' ')[0];
  const firstIncoming = incomingText.split(' ')[0];
  return Boolean(firstStored && firstIncoming && firstStored === firstIncoming);
}

module.exports = {
  asText,
  collectSignal,
  extractComparableNumbers,
  extractTextParts,
  hasAnyPhrase,
  hasAnyToken,
  sameSubject,
  stripSubject,
};
