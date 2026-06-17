'use strict';

const crypto = require('node:crypto');

const FINDING_KINDS = Object.freeze([
  'bug',
  'security',
  'flaky_test',
  'stale_docs',
  'unsafe_pattern',
  'release_hygiene',
]);

const FINDING_SEVERITIES = Object.freeze([
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);

const FINDING_STATUSES = Object.freeze([
  'candidate',
  'validated',
  'rejected',
  'resolved',
]);

const EVIDENCE_TYPES = Object.freeze([
  'file',
  'test',
  'log',
  'route',
  'commit',
  'manual',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeWorkspaceId(workspaceId) {
  return String(workspaceId || 'default').trim() || 'default';
}

function normalizeTimestamp(input) {
  const ts = input || new Date().toISOString();
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function normalizeString(value, fallback = '') {
  return String(value == null ? fallback : value).trim();
}

function normalizeEvidenceItem(item) {
  if (!isPlainObject(item)) {
    return null;
  }
  const normalized = {
    type: normalizeString(item.type),
    ref: normalizeString(item.ref),
    detail: normalizeString(item.detail),
  };
  return normalized;
}

function sortCanonicalEvidence(items) {
  return [...items].sort((a, b) => {
    const left = `${a.type}\u0000${a.ref}\u0000${a.detail}`;
    const right = `${b.type}\u0000${b.ref}\u0000${b.detail}`;
    return left.localeCompare(right);
  });
}

function createFindingId(input, opts = {}) {
  const workspaceId = normalizeWorkspaceId(opts.workspaceId ?? input?.workspaceId);
  const kind = normalizeString(input?.kind);
  const title = normalizeString(input?.title);
  const evidence = Array.isArray(input?.evidence)
    ? sortCanonicalEvidence(input.evidence.map(normalizeEvidenceItem).filter(Boolean))
    : [];
  const payload = {
    workspaceId,
    kind,
    title,
    evidence,
  };
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 16);
  return `finding_${hash}`;
}

function classifyFindingSeverity(input = {}) {
  if (FINDING_SEVERITIES.includes(input.severity)) {
    return input.severity;
  }
  switch (input.kind) {
    case 'security':
      return 'high';
    case 'unsafe_pattern':
      return 'high';
    case 'bug':
      return 'medium';
    case 'flaky_test':
      return 'low';
    case 'stale_docs':
      return 'info';
    case 'release_hygiene':
      return 'low';
    default:
      return 'medium';
  }
}

function normalizeSuggestedFix(input) {
  const suggestedFix = isPlainObject(input?.suggestedFix) ? input.suggestedFix : {};
  return {
    summary: normalizeString(suggestedFix.summary),
    allowedFiles: Array.isArray(suggestedFix.allowedFiles)
      ? suggestedFix.allowedFiles.map((value) => normalizeString(value)).filter(Boolean)
      : [],
    forbiddenFiles: Array.isArray(suggestedFix.forbiddenFiles)
      ? suggestedFix.forbiddenFiles.map((value) => normalizeString(value)).filter(Boolean)
      : [],
    risk: normalizeString(suggestedFix.risk),
  };
}

function normalizeArrayField(source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) {
    return [];
  }
  if (!Array.isArray(source[key])) {
    return source[key];
  }
  return source[key].map((value) => normalizeString(value)).filter(Boolean);
}

function normalizeFinding(input, opts = {}) {
  const source = isPlainObject(input) ? input : {};
  const evidence = !Object.prototype.hasOwnProperty.call(source, 'evidence')
    ? []
    : Array.isArray(source.evidence)
      ? source.evidence.map(normalizeEvidenceItem).filter(Boolean)
      : source.evidence;
  const workspaceId = normalizeWorkspaceId(opts.workspaceId ?? source.workspaceId);
  const createdAt = normalizeTimestamp(opts.createdAt ?? source.createdAt);
  const updatedAt = normalizeTimestamp(opts.updatedAt ?? source.updatedAt ?? createdAt);
  const normalized = {
    findingId: normalizeString(source.findingId) || createFindingId(source, { workspaceId }),
    kind: normalizeString(source.kind),
    severity: normalizeString(source.severity) || classifyFindingSeverity(source),
    confidence: typeof source.confidence === 'number' ? source.confidence : Number(source.confidence ?? 0.5),
    title: normalizeString(source.title),
    summary: normalizeString(source.summary),
    evidence: Array.isArray(evidence) ? sortCanonicalEvidence(evidence) : evidence,
    affectedFiles: normalizeArrayField(source, 'affectedFiles'),
    suggestedTests: normalizeArrayField(source, 'suggestedTests'),
    suggestedFix: normalizeSuggestedFix(source),
    riskFlags: normalizeArrayField(source, 'riskFlags'),
    status: normalizeString(source.status) || 'candidate',
    workspaceId,
    createdAt,
    updatedAt,
    receiptId: source.receiptId == null ? null : normalizeString(source.receiptId),
  };
  return normalized;
}

function validateEvidenceItem(item, index, errors) {
  if (!isPlainObject(item)) {
    errors.push({ field: `evidence[${index}]`, code: 'VALIDATION_ERROR', message: 'evidence item must be an object' });
    return;
  }
  if (!EVIDENCE_TYPES.includes(item.type)) {
    errors.push({ field: `evidence[${index}].type`, code: 'VALIDATION_ERROR', message: 'evidence type is invalid' });
  }
  if (!item.ref) {
    errors.push({ field: `evidence[${index}].ref`, code: 'VALIDATION_ERROR', message: 'evidence ref is required' });
  }
  if (!item.detail) {
    errors.push({ field: `evidence[${index}].detail`, code: 'VALIDATION_ERROR', message: 'evidence detail is required' });
  }
}

function validateFinding(finding) {
  const errors = [];
  const normalized = isPlainObject(finding) ? finding : null;
  if (!normalized) {
    return { ok: false, errors: [{ field: 'finding', code: 'VALIDATION_ERROR', message: 'finding must be an object' }] };
  }
  if (!normalizeString(normalized.findingId)) {
    errors.push({ field: 'findingId', code: 'VALIDATION_ERROR', message: 'findingId is required' });
  }
  if (!normalizeString(normalized.title)) {
    errors.push({ field: 'title', code: 'VALIDATION_ERROR', message: 'title is required' });
  }
  if (!FINDING_KINDS.includes(normalizeString(normalized.kind))) {
    errors.push({ field: 'kind', code: 'VALIDATION_ERROR', message: 'kind is invalid' });
  }
  if (!FINDING_SEVERITIES.includes(normalizeString(normalized.severity))) {
    errors.push({ field: 'severity', code: 'VALIDATION_ERROR', message: 'severity is invalid' });
  }
  if (typeof normalized.confidence !== 'number' || Number.isNaN(normalized.confidence) || normalized.confidence < 0 || normalized.confidence > 1) {
    errors.push({ field: 'confidence', code: 'VALIDATION_ERROR', message: 'confidence must be between 0 and 1' });
  }
  if (!Array.isArray(normalized.evidence)) {
    errors.push({ field: 'evidence', code: 'VALIDATION_ERROR', message: 'evidence must be an array' });
  }
  if (!Array.isArray(normalized.affectedFiles)) {
    errors.push({ field: 'affectedFiles', code: 'VALIDATION_ERROR', message: 'affectedFiles must be an array' });
  }
  if (!Array.isArray(normalized.suggestedTests)) {
    errors.push({ field: 'suggestedTests', code: 'VALIDATION_ERROR', message: 'suggestedTests must be an array' });
  }
  if (!Array.isArray(normalized.riskFlags)) {
    errors.push({ field: 'riskFlags', code: 'VALIDATION_ERROR', message: 'riskFlags must be an array' });
  }
  if (!FINDING_STATUSES.includes(normalizeString(normalized.status))) {
    errors.push({ field: 'status', code: 'VALIDATION_ERROR', message: 'status is invalid' });
  }
  if (!normalizeString(normalized.workspaceId)) {
    errors.push({ field: 'workspaceId', code: 'VALIDATION_ERROR', message: 'workspaceId is required' });
  }
  if (!normalizeString(normalized.createdAt) || Number.isNaN(Date.parse(normalized.createdAt))) {
    errors.push({ field: 'createdAt', code: 'VALIDATION_ERROR', message: 'createdAt must be a parseable timestamp' });
  }
  if (!normalizeString(normalized.updatedAt) || Number.isNaN(Date.parse(normalized.updatedAt))) {
    errors.push({ field: 'updatedAt', code: 'VALIDATION_ERROR', message: 'updatedAt must be a parseable timestamp' });
  }
  if (normalized.receiptId !== null && !normalizeString(normalized.receiptId)) {
    errors.push({ field: 'receiptId', code: 'VALIDATION_ERROR', message: 'receiptId must be null or a non-empty string' });
  }
  normalized.evidence && normalized.evidence.forEach((item, index) => validateEvidenceItem(item, index, errors));
  if (isPlainObject(normalized.suggestedFix)) {
    if (!Array.isArray(normalized.suggestedFix.allowedFiles)) {
      errors.push({ field: 'suggestedFix.allowedFiles', code: 'VALIDATION_ERROR', message: 'suggestedFix.allowedFiles must be an array' });
    }
    if (!Array.isArray(normalized.suggestedFix.forbiddenFiles)) {
      errors.push({ field: 'suggestedFix.forbiddenFiles', code: 'VALIDATION_ERROR', message: 'suggestedFix.forbiddenFiles must be an array' });
    }
  } else {
    errors.push({ field: 'suggestedFix', code: 'VALIDATION_ERROR', message: 'suggestedFix must be an object' });
  }
  return { ok: errors.length === 0, errors };
}

function createFinding(input, opts = {}) {
  const normalized = normalizeFinding(input, opts);
  const validation = validateFinding(normalized);
  if (!validation.ok) {
    const error = new Error('Invalid finding');
    error.validation = validation;
    throw error;
  }
  return clone(normalized);
}

function isFinding(value) {
  return validateFinding(value).ok;
}

module.exports = {
  FINDING_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  EVIDENCE_TYPES,
  classifyFindingSeverity,
  createFinding,
  createFindingId,
  isFinding,
  normalizeFinding,
  validateFinding,
};
