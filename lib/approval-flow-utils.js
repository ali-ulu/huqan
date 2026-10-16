const crypto = require('crypto');

const APPROVAL_DECISION_STATUSES = Object.freeze([
  'approved',
  'rejected',
]);

function trimText(value, fallback = '') {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function pushError(errors, field, message, code = 'VALIDATION_ERROR') {
  errors.push({ code, field, message });
}

function makeDecisionId(prefix, parts) {
  const basis = parts.map((part) => trimText(part, '')).join('|');
  // sha256 + 32 hex chars (128 bits) instead of sha1 + 16 hex chars (64 bits),
  // see #385.
  return `${prefix}_${crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 32)}`;
}

function normalizeDecisionStatus(status) {
  const raw = trimText(status, '').toLowerCase();
  return APPROVAL_DECISION_STATUSES.includes(raw) ? raw : '';
}

module.exports = {
  APPROVAL_DECISION_STATUSES,
  trimText,
  nowIso,
  pushError,
  makeDecisionId,
  normalizeDecisionStatus,
};
