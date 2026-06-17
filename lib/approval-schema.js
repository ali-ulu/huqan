const crypto = require('crypto');

const APPROVAL_REQUEST_STATUSES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);

const APPROVAL_REQUEST_VERDICTS = Object.freeze([
  'allow',
  'review',
  'dry_run_only',
  'block',
]);

const APPROVAL_REQUEST_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'approvalId',
    'workspaceId',
    'agentId',
    'actor',
    'owner',
    'actionType',
    'toolName',
    'actionPayload',
    'requestedVerdict',
    'riskScore',
    'reason',
    'provenanceId',
    'trustPolicyVersion',
    'status',
    'createdAt',
  ],
  properties: Object.freeze({
    approvalId: { type: 'string' },
    workspaceId: { type: 'string' },
    agentId: { type: 'string' },
    actor: { type: 'string' },
    owner: { type: 'string' },
    actionType: { type: 'string' },
    toolName: { type: 'string' },
    actionPayload: { type: 'any-json-safe' },
    requestedVerdict: { type: 'string', enum: APPROVAL_REQUEST_VERDICTS },
    riskScore: { type: 'number', min: 0, max: 100 },
    reason: { type: 'string' },
    provenanceId: { type: 'string' },
    trustPolicyVersion: { type: 'string' },
    receiptId: { type: 'string', optional: true },
    status: { type: 'string', enum: APPROVAL_REQUEST_STATUSES },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', optional: true },
    metadata: { type: 'any-json-safe', optional: true },
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function trimText(value, fallback = '') {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || fallback;
}

function normalizeWorkspaceId(workspaceId) {
  return trimText(workspaceId, 'default') || 'default';
}

function normalizeStatus(status) {
  const raw = trimText(status, '');
  if (!raw) return 'pending';
  return raw.toLowerCase();
}

function normalizeVerdict(verdict) {
  const raw = trimText(verdict, '');
  if (!raw) return 'review';
  return raw.toLowerCase();
}

function normalizeRiskScore(riskScore) {
  if (riskScore === undefined || riskScore === null || riskScore === '') return 0;
  const score = Number(riskScore);
  if (!Number.isFinite(score)) return Number.NaN;
  return Math.round(score);
}

function isJsonSafe(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch (_) {
    return false;
  }
}

function makeApprovalId(request) {
  const basis = [
    request.workspaceId || 'default',
    request.agentId || '',
    request.actor || '',
    request.owner || '',
    request.actionType || '',
    request.toolName || '',
    request.provenanceId || '',
    request.reason || '',
    request.createdAt || '',
  ].join('|');
  return `apr_${crypto.createHash('sha1').update(basis, 'utf8').digest('hex').slice(0, 16)}`;
}

function pushError(errors, field, message, code = 'VALIDATION_ERROR') {
  errors.push({ code, field, message });
}

function normalizeApprovalRequest(request = {}, opts = {}) {
  const source = isPlainObject(request) ? request : {};
  const next = clone(source) || {};

  next.approvalId = trimText(next.approvalId, trimText(opts.approvalId, ''));
  next.workspaceId = normalizeWorkspaceId(next.workspaceId ?? opts.workspaceId);
  next.agentId = trimText(next.agentId, trimText(opts.agentId, ''));
  next.actor = trimText(next.actor, trimText(opts.actor, ''));
  next.owner = trimText(next.owner, trimText(opts.owner, ''));
  next.actionType = trimText(next.actionType, trimText(opts.actionType, ''));
  next.toolName = trimText(next.toolName, trimText(opts.toolName, ''));
  next.requestedVerdict = normalizeVerdict(next.requestedVerdict ?? opts.requestedVerdict);
  next.riskScore = normalizeRiskScore(next.riskScore ?? opts.riskScore);
  next.reason = trimText(next.reason, trimText(opts.reason, ''));
  next.provenanceId = trimText(next.provenanceId, trimText(opts.provenanceId, ''));
  next.trustPolicyVersion = trimText(next.trustPolicyVersion, trimText(opts.trustPolicyVersion, ''));
  next.receiptId = trimText(next.receiptId, trimText(opts.receiptId, ''));
  next.status = normalizeStatus(next.status ?? opts.status);
  next.createdAt = trimText(next.createdAt, trimText(opts.createdAt, ''));
  next.expiresAt = trimText(next.expiresAt, trimText(opts.expiresAt, ''));
  next.actionPayload = next.actionPayload !== undefined ? clone(next.actionPayload) : clone(opts.actionPayload);
  next.metadata = next.metadata !== undefined ? clone(next.metadata) : clone(opts.metadata);
  return next;
}

function validateApprovalRequest(request = {}) {
  const warnings = [];
  const errors = [];
  const normalized = normalizeApprovalRequest(request);

  if (!isPlainObject(request)) {
    pushError(errors, '', 'approval request must be an object', 'INVALID_APPROVAL_REQUEST');
    return { ok: false, type: 'approval-request', warnings, errors, request: normalized };
  }

  const requiredStrings = [
    'approvalId',
    'workspaceId',
    'agentId',
    'actor',
    'owner',
    'actionType',
    'toolName',
    'reason',
    'provenanceId',
    'trustPolicyVersion',
    'status',
    'createdAt',
  ];
  for (const field of requiredStrings) {
    if (!trimText(normalized[field])) pushError(errors, field, `${field} is required`);
  }

  if (normalized.actionPayload === undefined || normalized.actionPayload === null) {
    pushError(errors, 'actionPayload', 'actionPayload is required');
  } else if (!isJsonSafe(normalized.actionPayload)) {
    pushError(errors, 'actionPayload', 'actionPayload must be JSON-safe');
  }

  if (!APPROVAL_REQUEST_VERDICTS.includes(normalized.requestedVerdict)) {
    pushError(errors, 'requestedVerdict', 'requestedVerdict is not supported');
  }

  if (!APPROVAL_REQUEST_STATUSES.includes(normalized.status)) {
    pushError(errors, 'status', 'status is not supported');
  }

  if (!Number.isFinite(normalized.riskScore)) {
    pushError(errors, 'riskScore', 'riskScore must be a finite number');
  } else if (normalized.riskScore < 0 || normalized.riskScore > 100) {
    pushError(errors, 'riskScore', 'riskScore must be between 0 and 100');
  }

  if (normalized.createdAt && Number.isNaN(Date.parse(normalized.createdAt))) {
    pushError(errors, 'createdAt', 'createdAt must be a parseable timestamp');
  }

  if (normalized.expiresAt && Number.isNaN(Date.parse(normalized.expiresAt))) {
    pushError(errors, 'expiresAt', 'expiresAt must be a parseable timestamp when present');
  }

  if (normalized.metadata !== undefined && normalized.metadata !== null && !isJsonSafe(normalized.metadata)) {
    pushError(errors, 'metadata', 'metadata must be JSON-safe');
  }

  return { ok: errors.length === 0, type: 'approval-request', warnings, errors, request: normalized };
}

function buildApprovalRequest(request = {}, opts = {}) {
  const now = trimText(opts.createdAt, nowIso()) || nowIso();
  const normalized = normalizeApprovalRequest(request, {
    ...opts,
    workspaceId: opts.workspaceId || request.workspaceId,
    requestedVerdict: opts.requestedVerdict || request.requestedVerdict || 'review',
    status: opts.status || request.status || 'pending',
    riskScore: opts.riskScore ?? request.riskScore ?? 0,
    createdAt: now,
  });

  if (!trimText(normalized.approvalId)) {
    normalized.approvalId = makeApprovalId(normalized);
  }
  if (!trimText(normalized.workspaceId)) normalized.workspaceId = 'default';
  if (!trimText(normalized.createdAt)) normalized.createdAt = nowIso();
  if (!trimText(normalized.status)) normalized.status = 'pending';
  if (!trimText(normalized.requestedVerdict)) normalized.requestedVerdict = 'review';
  if (!Number.isFinite(normalized.riskScore)) normalized.riskScore = 0;
  if (normalized.metadata === undefined) normalized.metadata = {};

  const validation = validateApprovalRequest(normalized);
  return validation.ok
    ? { ...validation, request: normalized }
    : validation;
}

module.exports = {
  APPROVAL_REQUEST_SCHEMA,
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_VERDICTS,
  buildApprovalRequest,
  normalizeApprovalRequest,
  validateApprovalRequest,
};
