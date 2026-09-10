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

const OUTCOME_RECEIPT_KIND = 'external_action_outcome_receipt';

/**
 * External-action receipts are written into the audit log as `details` itself
 * (see createDurableExternalActionReceiptWriter), not wrapped under
 * `details.receipt` the way memory-admission events are. Reading only the
 * wrapped shape meant every browser and shell action projected `receipt: null`
 * -- the events were in the trail, but the pane showed nothing about them.
 * Both shapes are accepted; the wrapped one keeps precedence so existing
 * callers project exactly as before.
 */
function receiptSource(event) {
  const details = objectOrEmpty(event.details);
  const wrapped = objectOrEmpty(details.receipt);
  if (trimText(wrapped.receiptId)) return wrapped;
  return trimText(details.receiptId) ? details : null;
}

/**
 * The destination, projected only as far as the receipt itself vouches for it:
 * scheme, host and path, never a query string or page content. A receipt that
 * carried no safe destination projects null rather than a guess.
 */
function destinationSummary(metadata) {
  const destination = objectOrEmpty(metadata.destination);
  const url = trimText(destination.url);
  if (!url) return null;
  return {
    url,
    scheme: trimText(destination.scheme),
    host: trimText(destination.host),
    path: trimText(destination.path),
    truncated: Boolean(destination.truncated),
  };
}

function receiptSummary(event) {
  const receipt = receiptSource(event);
  if (!receipt) return null;
  const metadata = objectOrEmpty(receipt.metadata);
  const issuer = objectOrEmpty(receipt.issuer);
  // An admission receipt records that an action was allowed to proceed, not
  // that it ran. Only an outcome receipt may project an executed status or an
  // effect verification; anything else would let the pane read "executed" off
  // a decision that was merely permitted.
  const isOutcome = trimText(receipt.receiptKind) === OUTCOME_RECEIPT_KIND;
  return {
    receiptId: trimText(receipt.receiptId),
    decision: trimText(receipt.decision),
    reason: trimText(receipt.reason),
    action: trimText(metadata.action || receipt.action),
    tool: trimText(metadata.tool || receipt.tool),
    ...(trimText(receipt.receiptKind).startsWith('external_action_') ? {
      receiptKind: trimText(receipt.receiptKind),
      toolName: trimText(metadata.toolName || metadata.tool || receipt.tool),
      destination: destinationSummary(metadata),
    // Named `reported*` because that is all they are: what the executor said
    // happened, unless `effectVerification` is `observed`.
    reportedOutcomeStatus: isOutcome ? trimText(metadata.outcomeStatus || receipt.status) : '',
      effectVerification: isOutcome ? trimText(metadata.effectVerification) : '',
    } : {}),
    agentId: trimText(metadata.agentId || receipt.agentId || issuer.agentId),
    traceId: trimText(metadata.traceId || receipt.traceId),
    createdAt: trimText(receipt.createdAt),
  };
}

function projectActivityEvent(event = {}) {
  const details = objectOrEmpty(event.details);
  const receipt = receiptSummary(event);
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
    action: trimText(details.action || receipt?.action || receipt?.toolName),
    tool: trimText(details.tool || details.toolName || receipt?.toolName),
    traceId: trimText(details.traceId),
    receipt,
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
