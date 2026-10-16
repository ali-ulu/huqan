// Text, evidence and fact helpers the run and causal summaries share, moved
// out of finalizer.js (#2170).

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return `[unserializable:${Object.prototype.toString.call(value)}]`;
  }
}

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return normalizeText(value);
  if (typeof value !== 'object') return normalizeText(value);
  const candidates = [
    value.finalAnswer,
    value.answer,
    value.summary,
    value.explanation,
    value.reason,
    value.text,
    value.output,
    value.result,
    value.message,
  ];
  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text) return text;
  }
  return '';
}

function normalizeEvidenceItem(item) {
  if (item === undefined || item === null) return null;
  if (typeof item === 'string') {
    return { type: 'text', value: normalizeText(item) };
  }
  if (typeof item !== 'object') {
    return { type: 'value', value: item };
  }
  const normalized = cloneValue(item);
  if (Object.prototype.hasOwnProperty.call(normalized, 'value')) {
    normalized.value = extractText(normalized.value) || normalized.value;
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'confidence')) {
    const num = Number(normalized.confidence);
    normalized.confidence = Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
  }
  return normalized;
}

function normalizeEvidence(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(normalizeEvidenceItem).filter(Boolean);
}

function stableKey(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `str:${foldText(value)}`;
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  return `obj:${safeStringify(value)}`;
}

function dedupeStable(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = stableKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function cleanFactText(text) {
  const value = normalizeText(text);
  if (!value) return '';
  return value
    .replace(/^(ask|verify|reason|dream|compare|learn|plan|summary|result|analysis)\s*[:-]\s*/i, '')
    .replace(/^[-•\u2022]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const UNKNOWN_TOKENS = Object.freeze([
  'bilinmiyor', 'bilmiyorum', 'unknown', 'insufficient', 'yetersiz',
  'no data', 'not enough', 'belirsiz', 'unclear',
]);
const CONTRADICTION_TOKENS = Object.freeze([
  'celiski', 'contradiction', 'contradict', 'conflict', 'blocked',
]);

function hasStandaloneToken(text, tokens) {
  const value = foldText(text);
  return tokens.some((token) => new RegExp(
    `(?<![\\p{L}\\p{N}])${token}(?![\\p{L}\\p{N}])`,
    'u',
  ).test(value));
}

function hasNegatedTokenBefore(value, index) {
  const prefix = value.slice(Math.max(0, index - 80), index);
  return /(?:^|[^\p{L}\p{N}])(?:no|not|without)(?:[\s-]+[\p{L}\p{N}]+){0,2}[\s-]*$/u.test(prefix);
}

function isUnknownText(text) {
  return hasStandaloneToken(text, UNKNOWN_TOKENS);
}

function isContradictionText(text) {
  const value = foldText(text);
  return CONTRADICTION_TOKENS.some((token) => {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${token}(?![\\p{L}\\p{N}])`, 'gu');
    let match;
    while ((match = pattern.exec(value)) !== null) {
      if (!hasNegatedTokenBefore(value, match.index)) return true;
    }
    return false;
  });
}

module.exports = {
  cloneValue,
  safeStringify,
  foldText,
  normalizeText,
  extractText,
  normalizeEvidenceItem,
  normalizeEvidence,
  stableKey,
  dedupeStable,
  cleanFactText,
  UNKNOWN_TOKENS,
  CONTRADICTION_TOKENS,
  hasStandaloneToken,
  hasNegatedTokenBefore,
  isUnknownText,
  isContradictionText,
};
