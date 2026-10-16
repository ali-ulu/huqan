'use strict';

// Pure value normalisers shared by the workflow agent and its tool registry.
// Moved out of workflow-agent.js (#2132) unchanged.

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function normalizeConfidence(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return clamp01(fallback);
  return clamp01(num);
}

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(value) {
  return foldText(value)
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function normalizeEvidenceItem(item) {
  if (item === undefined || item === null) return null;
  if (Array.isArray(item)) {
    return item.map(normalizeEvidenceItem).filter(Boolean);
  }
  if (typeof item === 'string') {
    return { type: 'text', value: item };
  }
  if (typeof item !== 'object') {
    return { type: 'value', value: item };
  }
  const normalized = cloneValue(item);
  if (Object.prototype.hasOwnProperty.call(normalized, 'confidence')) {
    normalized.confidence = normalizeConfidence(normalized.confidence, 0);
  }
  return normalized;
}

function normalizeEvidence(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap(normalizeEvidenceItem).filter(Boolean);
}

function normalizeError(error, fallbackCode = 'ERROR', fallbackMessage = 'Tool execution failed.') {
  if (!error) {
    return { code: fallbackCode, message: fallbackMessage };
  }
  if (typeof error === 'string') {
    return { code: fallbackCode, message: error };
  }
  const code = error.code || fallbackCode;
  const message = error.message || fallbackMessage;
  return { code: String(code), message: String(message) };
}

function extractText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return String(value);
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
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function normalizePositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

module.exports = {
  cloneValue,
  normalizeName,
  clamp01,
  normalizeConfidence,
  foldText,
  tokenize,
  normalizeEvidenceItem,
  normalizeEvidence,
  normalizeError,
  extractText,
  normalizePositiveInteger,
};
