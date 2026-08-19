'use strict';

const { clampAuditLimit } = require('../audit-query');

const ACTIVITY_FILTERS = Object.freeze([
  'eventType',
  'actor',
  'targetType',
  'targetId',
  'provenanceId',
  'sourceRef',
]);

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function receiptSummary(event) {
  const details = objectOrEmpty(event.details);
  const receipt = objectOrEmpty(details.receipt);
  if (!trimText(receipt.receiptId)) return null;
  const metadata = objectOrEmpty(receipt.metadata);
  const issuer = objectOrEmpty(receipt.issuer);
  return {
    receiptId: trimText(receipt.receiptId),
    decision: trimText(receipt.decision),
    reason: trimText(receipt.reason),
    action: trimText(metadata.action || receipt.action),
    tool: trimText(metadata.tool || receipt.tool),
    agentId: trimText(metadata.agentId || receipt.agentId || issuer.agentId),
    traceId: trimText(metadata.traceId || receipt.traceId),
    createdAt: trimText(receipt.createdAt),
  };
}

function projectActivityEvent(event = {}) {
  const details = objectOrEmpty(event.details);
  return {
    auditId: trimText(event.auditId),
    eventType: trimText(event.eventType),
    targetType: trimText(event.targetType),
    targetId: trimText(event.targetId),
    workspaceId: trimText(event.workspaceId) || 'default',
    actor: trimText(event.actor) || 'system',
    timestamp: trimText(event.timestamp),
    sourceRef: trimText(event.sourceRef),
    provenanceId: trimText(event.provenanceId),
    trustPolicyVersion: trimText(event.trustPolicyVersion),
    action: trimText(details.action),
    tool: trimText(details.tool || details.toolName),
    traceId: trimText(details.traceId),
    receipt: receiptSummary(event),
  };
}

function readFilters(options = {}) {
  const filters = { workspaceId: options.workspaceId };
  for (const key of ACTIVITY_FILTERS) {
    const value = trimText(options[key]);
    if (value) filters[key] = value;
  }
  return filters;
}

function queryAgentActivity(source, options = {}) {
  if (!source || typeof source.queryAuditEvents !== 'function') {
    return {
      ok: false,
      status: 'unavailable',
      error: { code: 'ACTIVITY_SOURCE_UNAVAILABLE' },
    };
  }

  try {
    const page = source.queryAuditEvents({
      filters: readFilters(options),
      limit: clampAuditLimit(options.limit),
      cursor: trimText(options.cursor) || undefined,
      order: options.order === 'asc' ? 'asc' : 'desc',
    });
    return {
      ok: true,
      status: 'found',
      items: page.items.map(projectActivityEvent),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      limit: page.limit,
      order: options.order === 'asc' ? 'asc' : 'desc',
      source: { kind: 'audit_query', readOnly: true, bounded: true },
    };
  } catch (error) {
    console.error('[workbench-activity] read failed:', error);
    return {
      ok: false,
      status: 'read_error',
      error: { code: 'ACTIVITY_READ_FAILED' },
    };
  }
}

module.exports = {
  ACTIVITY_FILTERS,
  projectActivityEvent,
  queryAgentActivity,
};
