'use strict';

const {
  EVIDENCE_TYPES,
  createFinding,
  normalizeFinding,
  validateFinding,
} = require('./finding-schema');

const FINDING_KIND_ALIASES = Object.freeze({
  bug: 'bug',
  bugs: 'bug',
  security: 'security',
  secure: 'security',
  flaky: 'flaky_test',
  flakey: 'flaky_test',
  flaky_test: 'flaky_test',
  flakytest: 'flaky_test',
  test_flake: 'flaky_test',
  docs: 'stale_docs',
  doc: 'stale_docs',
  documentation: 'stale_docs',
  stale_docs: 'stale_docs',
  unsafe: 'unsafe_pattern',
  unsafe_pattern: 'unsafe_pattern',
  release: 'release_hygiene',
  release_hygiene: 'release_hygiene',
});

const FINDING_KIND_KEYWORDS = Object.freeze([
  { kind: 'security', terms: ['auth', 'unauth', 'bypass', 'verify', 'route', 'csp', 'sri', 'secret'] },
  { kind: 'flaky_test', terms: ['flake', 'flaky', 'intermittent', 'order', 'timing', 'race'] },
  { kind: 'stale_docs', terms: ['docs', 'documentation', 'roadmap', 'readme', 'adr', 'closeout'] },
  { kind: 'unsafe_pattern', terms: ['path traversal', 'traversal', 'escape', 'concat', 'unsafe', 'vault'] },
  { kind: 'release_hygiene', terms: ['release', 'tag', 'version', 'package', 'changelog'] },
  { kind: 'bug', terms: ['bug', 'error', 'fail', 'broken', 'regression'] },
]);

const SEVERITY_BY_KIND = Object.freeze({
  security: 'high',
  unsafe_pattern: 'high',
  bug: 'medium',
  flaky_test: 'low',
  stale_docs: 'info',
  release_hygiene: 'low',
});

const CONFIDENCE_BY_KIND = Object.freeze({
  security: 0.92,
  unsafe_pattern: 0.88,
  bug: 0.72,
  flaky_test: 0.61,
  stale_docs: 0.54,
  release_hygiene: 0.58,
});

const SEVERITY_ORDER = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);
const SEVERITY_SIGNAL_MAP = Object.freeze({
  info: 'info',
  low: 'low',
  medium: 'medium',
  med: 'medium',
  moderate: 'medium',
  high: 'high',
  critical: 'critical',
  blocker: 'critical',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, fallback = '') {
  return String(value == null ? fallback : value).trim();
}

function clampConfidence(value, fallback = 0.5) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, parsed));
}

function flattenRawText(input) {
  if (!isPlainObject(input)) {
    return '';
  }
  const parts = [
    input.type,
    input.kind,
    input.title,
    input.summary,
    input.description,
    input.message,
    Array.isArray(input.evidence)
      ? input.evidence
          .map((item) => (isPlainObject(item) ? [item.type, item.ref, item.detail].filter(Boolean).join(' ') : ''))
          .join(' ')
      : '',
  ];
  return parts.map((part) => normalizeString(part).toLowerCase()).filter(Boolean).join(' ');
}

function classifyFindingKind(input) {
  if (!isPlainObject(input)) {
    return null;
  }
  const direct = normalizeString(input.kind || input.type).toLowerCase();
  if (FINDING_KIND_ALIASES[direct]) {
    return FINDING_KIND_ALIASES[direct];
  }

  if (direct) {
    return null;
  }

  const haystack = flattenRawText(input);
  for (const candidate of FINDING_KIND_KEYWORDS) {
    if (candidate.terms.some((term) => haystack.includes(term))) {
      return candidate.kind;
    }
  }
  return null;
}

function classifySeverity(input) {
  if (!isPlainObject(input)) {
    return 'medium';
  }

  const explicit = normalizeString(input.severity).toLowerCase();
  if (SEVERITY_ORDER.includes(explicit)) {
    return explicit;
  }

  const signal = normalizeString(input.severitySignal).toLowerCase();
  if (SEVERITY_SIGNAL_MAP[signal]) {
    return SEVERITY_SIGNAL_MAP[signal];
  }

  const kind = classifyFindingKind(input);
  return kind ? SEVERITY_BY_KIND[kind] : 'medium';
}

function classifyConfidence(input) {
  if (!isPlainObject(input)) {
    return 0.5;
  }

  const explicit = clampConfidence(input.confidenceSignal ?? input.confidence, NaN);
  if (!Number.isNaN(explicit)) {
    return explicit;
  }

  const kind = classifyFindingKind(input);
  if (kind && Object.prototype.hasOwnProperty.call(CONFIDENCE_BY_KIND, kind)) {
    return CONFIDENCE_BY_KIND[kind];
  }
  return 0.5;
}

function normalizeEvidenceItem(item) {
  if (!isPlainObject(item)) {
    return null;
  }
  const type = normalizeString(item.type).toLowerCase();
  const ref = normalizeString(item.ref || item.path || item.file || item.sourceRef || item.location);
  const detail = normalizeString(item.detail || item.message || item.summary || item.note || item.description);
  if (!ref && !detail) {
    return null;
  }
  return {
    type: EVIDENCE_TYPES.includes(type) ? type : 'manual',
    ref: ref || detail || 'raw-evidence',
    detail: detail || ref || 'raw evidence',
  };
}

function normalizeArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => normalizeString(value)).filter(Boolean);
}

function normalizeClassifiedFinding(input, opts = {}) {
  if (!isPlainObject(input)) {
    throw new Error('Invalid raw finding input');
  }

  const kind = classifyFindingKind(input);
  if (!kind) {
    throw new Error('Unable to classify raw finding type');
  }

  const title = normalizeString(input.title || input.summary || input.message || `${kind} finding`);
  if (!title) {
    throw new Error('Unable to classify raw finding title');
  }

  const summary = normalizeString(input.summary || input.description || input.message || title);
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.map(normalizeEvidenceItem).filter(Boolean)
    : [];
  const affectedFiles = normalizeArray(input.affectedFiles ?? input.files ?? input.paths);
  const suggestedTests = normalizeArray(input.suggestedTests ?? input.tests ?? input.suggestedTest);
  const riskFlags = normalizeArray(input.riskFlags ?? input.flags);
  const suggestedFix = isPlainObject(input.suggestedFix)
    ? input.suggestedFix
    : {
        summary: normalizeString(input.suggestedFixSummary),
        allowedFiles: [],
        forbiddenFiles: [],
        risk: normalizeString(input.suggestedFixRisk),
      };

  const finding = createFinding({
    kind,
    severity: classifySeverity(input),
    confidence: classifyConfidence(input),
    title,
    summary,
    evidence,
    affectedFiles,
    suggestedTests,
    suggestedFix,
    riskFlags,
    status: normalizeString(input.status) || 'candidate',
    receiptId: input.receiptId == null ? null : normalizeString(input.receiptId),
  }, {
    workspaceId: opts.workspaceId ?? input.workspaceId,
    createdAt: opts.createdAt ?? input.createdAt,
    updatedAt: opts.updatedAt ?? input.updatedAt,
  });

  return finding;
}

function classifyRawFinding(input, opts = {}) {
  return normalizeClassifiedFinding(input, opts);
}

module.exports = {
  classifyConfidence,
  classifyFindingKind,
  classifyRawFinding,
  classifySeverity,
  normalizeClassifiedFinding,
  validateFinding,
  normalizeFinding,
};
