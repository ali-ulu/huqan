const {
  APPROVAL_REQUEST_STATUSES,
  buildApprovalRequest,
  normalizeApprovalRequest,
  validateApprovalRequest,
} = require('./approval-schema');

const APPROVAL_QUEUE_STATUSES = Object.freeze([...APPROVAL_REQUEST_STATUSES]);

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

function isJsonSafe(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch (_) {
    return false;
  }
}

function compareQueueItems(left, right) {
  const leftTime = Date.parse(left.queuedAt || left.updatedAt || left.createdAt || '');
  const rightTime = Date.parse(right.queuedAt || right.updatedAt || right.createdAt || '');
  const leftValue = Number.isFinite(leftTime) ? leftTime : 0;
  const rightValue = Number.isFinite(rightTime) ? rightTime : 0;

  if (leftValue !== rightValue) return leftValue - rightValue;
  return String(left.approvalId || '').localeCompare(String(right.approvalId || ''));
}

function sortQueueItems(items) {
  return [...items].sort(compareQueueItems);
}

function normalizeQueueStatus(status) {
  const raw = trimText(status, '').toLowerCase();
  return raw || 'pending';
}

function normalizeApprovalQueueItem(item = {}, opts = {}) {
  const source = isPlainObject(item) ? item : {};
  const next = clone(source) || {};

  const approvalRequest = source.approvalRequest ?? source.request ?? source.approval ?? {};
  const normalizedRequest = normalizeApprovalRequest(approvalRequest, opts);
  const normalizedMetadata = next.metadata !== undefined ? clone(next.metadata) : clone(opts.metadata);
  const queuedAt = trimText(next.queuedAt, trimText(opts.queuedAt, ''));
  const updatedAt = trimText(next.updatedAt, trimText(opts.updatedAt, ''));
  const expiresAt = trimText(next.expiresAt, trimText(opts.expiresAt, normalizedRequest.expiresAt));

  next.approvalId = trimText(next.approvalId, normalizedRequest.approvalId);
  next.workspaceId = trimText(next.workspaceId, normalizedRequest.workspaceId || trimText(opts.workspaceId, 'default') || 'default');
  next.status = normalizeQueueStatus(next.status ?? opts.status ?? normalizedRequest.status);
  next.queuedAt = queuedAt;
  next.updatedAt = updatedAt;
  next.expiresAt = expiresAt;
  next.metadata = normalizedMetadata === undefined ? {} : normalizedMetadata;
  next.approvalRequest = normalizedRequest;
  next.request = normalizedRequest;
  return next;
}

function pushError(errors, field, message, code = 'VALIDATION_ERROR') {
  errors.push({ code, field, message });
}

function validateApprovalQueueItem(item = {}) {
  const warnings = [];
  const errors = [];
  const normalized = normalizeApprovalQueueItem(item);

  if (!isPlainObject(item)) {
    pushError(errors, '', 'approval queue item must be an object', 'INVALID_APPROVAL_QUEUE_ITEM');
    return { ok: false, type: 'approval-queue-item', warnings, errors, item: normalized };
  }

  const requestValidation = validateApprovalRequest(normalized.approvalRequest);
  if (!requestValidation.ok) {
    for (const error of requestValidation.errors) {
      errors.push({ ...error, field: error.field ? `approvalRequest.${error.field}` : 'approvalRequest' });
    }
  }

  if (trimText(normalized.status) !== 'pending') {
    pushError(errors, 'status', 'queue item must start pending');
  }

  if (!trimText(normalized.approvalId)) {
    pushError(errors, 'approvalId', 'approvalId is required');
  }

  if (!trimText(normalized.workspaceId)) {
    pushError(errors, 'workspaceId', 'workspaceId is required');
  }

  if (normalized.metadata !== undefined && normalized.metadata !== null && !isJsonSafe(normalized.metadata)) {
    pushError(errors, 'metadata', 'metadata must be JSON-safe');
  }

  if (normalized.queuedAt && Number.isNaN(Date.parse(normalized.queuedAt))) {
    pushError(errors, 'queuedAt', 'queuedAt must be a parseable timestamp when present');
  }

  if (normalized.updatedAt && Number.isNaN(Date.parse(normalized.updatedAt))) {
    pushError(errors, 'updatedAt', 'updatedAt must be a parseable timestamp when present');
  }

  if (normalized.expiresAt && Number.isNaN(Date.parse(normalized.expiresAt))) {
    pushError(errors, 'expiresAt', 'expiresAt must be a parseable timestamp when present');
  }

  return { ok: errors.length === 0, type: 'approval-queue-item', warnings, errors, item: normalized };
}

function buildApprovalQueueItem(item = {}, opts = {}) {
  const now = trimText(opts.now, nowIso()) || nowIso();
  const request = item.approvalRequest ?? item.request ?? item.approval ?? {};
  const approvalRequest = buildApprovalRequest(request, {
    ...opts,
    status: 'pending',
    createdAt: opts.createdAt || request.createdAt || now,
  });

  if (!approvalRequest.ok) {
    return {
      ok: false,
      type: 'approval-queue-item',
      warnings: approvalRequest.warnings,
      errors: approvalRequest.errors,
      item: normalizeApprovalQueueItem(item, opts),
    };
  }

  const normalized = normalizeApprovalQueueItem(item, {
    ...opts,
    approvalId: approvalRequest.request.approvalId,
    workspaceId: approvalRequest.request.workspaceId,
    status: 'pending',
    queuedAt: now,
    updatedAt: now,
    expiresAt: opts.expiresAt || approvalRequest.request.expiresAt || '',
    metadata: item.metadata ?? opts.metadata ?? {},
  });

  normalized.approvalRequest = clone(approvalRequest.request);
  normalized.request = normalized.approvalRequest;
  normalized.status = 'pending';
  normalized.queuedAt = now;
  normalized.updatedAt = now;
  if (!trimText(normalized.expiresAt)) normalized.expiresAt = trimText(approvalRequest.request.expiresAt, '');

  const validation = validateApprovalQueueItem(normalized);
  return validation.ok
    ? { ...validation, item: normalized }
    : validation;
}

function filterByWorkspace(items, workspaceId) {
  const targetWorkspaceId = trimText(workspaceId, 'default') || 'default';
  return items.filter((item) => trimText(item.workspaceId, 'default') === targetWorkspaceId);
}

function enqueueApprovalRequest(queue = [], approvalRequest = {}, opts = {}) {
  const sourceQueue = Array.isArray(queue) ? queue.map((item) => clone(item)) : [];
  const normalizedRequest = normalizeApprovalRequest(approvalRequest, opts);
  const validation = validateApprovalRequest(normalizedRequest);

  if (!validation.ok) {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: validation.warnings,
      errors: validation.errors,
      queue: sortQueueItems(sourceQueue),
      item: null,
    };
  }

  if (trimText(validation.request.status) !== 'pending') {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: [],
      errors: [{ code: 'INVALID_QUEUE_STATE', field: 'status', message: 'approval request must be pending before enqueue' }],
      queue: sortQueueItems(sourceQueue),
      item: null,
    };
  }

  const existingIndex = sourceQueue.findIndex((item) => trimText(item.approvalId) === trimText(validation.request.approvalId));
  if (existingIndex >= 0) {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: [],
      errors: [{ code: 'DUPLICATE_APPROVAL_ID', field: 'approvalId', message: 'approvalId already exists in queue' }],
      queue: sortQueueItems(sourceQueue),
      item: null,
    };
  }

  const built = buildApprovalQueueItem(
    {
      approvalRequest: validation.request,
      metadata: opts.metadata,
    },
    {
      ...opts,
      workspaceId: validation.request.workspaceId,
      approvalId: validation.request.approvalId,
      createdAt: validation.request.createdAt,
      expiresAt: validation.request.expiresAt,
      now: opts.now,
    },
  );

  if (!built.ok) {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: built.warnings,
      errors: built.errors,
      queue: sortQueueItems(sourceQueue),
      item: built.item,
    };
  }

  const nextQueue = sortQueueItems([...sourceQueue, built.item]);
  return { ok: true, type: 'approval-queue', warnings: [], errors: [], queue: nextQueue, item: built.item };
}

function listApprovalRequests(queue = [], opts = {}) {
  const workspaceId = opts.workspaceId;
  const sourceQueue = Array.isArray(queue) ? queue.map((item) => clone(item)) : [];
  const filtered = workspaceId ? filterByWorkspace(sourceQueue, workspaceId) : sourceQueue;
  return {
    ok: true,
    type: 'approval-queue',
    warnings: [],
    errors: [],
    approvals: sortQueueItems(filtered),
    count: filtered.length,
  };
}

function getApprovalRequest(queue = [], approvalId = '', opts = {}) {
  const sourceQueue = Array.isArray(queue) ? queue.map((item) => clone(item)) : [];
  const workspaceId = opts.workspaceId;
  const needle = trimText(approvalId, '');
  const matches = sourceQueue.filter((item) => trimText(item.approvalId) === needle);
  const item = workspaceId ? matches.find((candidate) => trimText(candidate.workspaceId, 'default') === trimText(workspaceId, 'default')) : matches[0];

  if (!item) {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: [],
      errors: [{ code: 'APPROVAL_NOT_FOUND', field: 'approvalId', message: 'approvalId not found' }],
      approvals: sortQueueItems(workspaceId ? filterByWorkspace(sourceQueue, workspaceId) : sourceQueue),
      item: null,
    };
  }

  return { ok: true, type: 'approval-queue', warnings: [], errors: [], item, approvals: sortQueueItems(sourceQueue), count: sourceQueue.length };
}

function updateApprovalRequestStatus(queue = [], approvalId = '', status = '', opts = {}) {
  const sourceQueue = Array.isArray(queue) ? queue.map((item) => clone(item)) : [];
  const normalizedStatus = normalizeQueueStatus(status);
  const workspaceId = trimText(opts.workspaceId, '');
  const currentIndex = sourceQueue.findIndex(
    (item) => trimText(item.approvalId) === trimText(approvalId) && (!workspaceId || trimText(item.workspaceId, 'default') === trimText(workspaceId, 'default')),
  );

  if (!APPROVAL_QUEUE_STATUSES.includes(normalizedStatus)) {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: [],
      errors: [{ code: 'INVALID_STATUS', field: 'status', message: 'status is not supported' }],
      queue: sortQueueItems(sourceQueue),
      item: null,
    };
  }

  if (currentIndex < 0) {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: [],
      errors: [{ code: 'APPROVAL_NOT_FOUND', field: 'approvalId', message: 'approvalId not found' }],
      queue: sortQueueItems(sourceQueue),
      item: null,
    };
  }

  const current = sourceQueue[currentIndex];
  const currentStatus = trimText(current.status, 'pending');
  const terminalStatuses = new Set(['approved', 'rejected', 'expired', 'cancelled']);

  if (currentStatus !== 'pending' && currentStatus !== normalizedStatus) {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: [],
      errors: [{ code: 'INVALID_STATUS_TRANSITION', field: 'status', message: `cannot transition from ${currentStatus} to ${normalizedStatus}` }],
      queue: sortQueueItems(sourceQueue),
      item: current,
    };
  }

  if (terminalStatuses.has(currentStatus) && currentStatus !== normalizedStatus) {
    return {
      ok: false,
      type: 'approval-queue',
      warnings: [],
      errors: [{ code: 'INVALID_STATUS_TRANSITION', field: 'status', message: `cannot transition from ${currentStatus} to ${normalizedStatus}` }],
      queue: sortQueueItems(sourceQueue),
      item: current,
    };
  }

  const updatedAt = trimText(opts.updatedAt, nowIso()) || nowIso();
  const nextItem = {
    ...current,
    status: normalizedStatus,
    updatedAt,
    approvalRequest: {
      ...clone(current.approvalRequest),
      status: normalizedStatus,
    },
  };
  nextItem.request = nextItem.approvalRequest;

  sourceQueue[currentIndex] = nextItem;
  const nextQueue = sortQueueItems(sourceQueue);
  return { ok: true, type: 'approval-queue', warnings: [], errors: [], queue: nextQueue, item: nextItem };
}

function expireApprovalRequests(queue = [], opts = {}) {
  const sourceQueue = Array.isArray(queue) ? queue.map((item) => clone(item)) : [];
  const now = trimText(opts.now, nowIso()) || nowIso();
  const nowTime = Date.parse(now);
  const nextQueue = sourceQueue.map((item) => {
    const status = trimText(item.status, 'pending');
    if (status !== 'pending') return item;

    const expiresAt = trimText(item.expiresAt, trimText(item.approvalRequest && item.approvalRequest.expiresAt, ''));
    if (!expiresAt || Number.isNaN(Date.parse(expiresAt)) || !Number.isFinite(nowTime)) return item;
    if (Date.parse(expiresAt) > nowTime) return item;

    return {
      ...item,
      status: 'expired',
      updatedAt: now,
      approvalRequest: {
        ...clone(item.approvalRequest),
        status: 'expired',
      },
    };
  });

  let expiredCount = 0;
  for (let i = 0; i < sourceQueue.length; i += 1) {
    if (trimText(sourceQueue[i].status, 'pending') === 'pending' && trimText(nextQueue[i].status, 'pending') === 'expired') {
      expiredCount += 1;
    }
  }

  return {
    ok: true,
    type: 'approval-queue',
    warnings: [],
    errors: [],
    queue: sortQueueItems(nextQueue),
    expiredCount,
    now,
  };
}

module.exports = {
  APPROVAL_QUEUE_STATUSES,
  buildApprovalQueueItem,
  enqueueApprovalRequest,
  expireApprovalRequests,
  getApprovalRequest,
  listApprovalRequests,
  normalizeApprovalQueueItem,
  updateApprovalRequestStatus,
  validateApprovalQueueItem,
};
