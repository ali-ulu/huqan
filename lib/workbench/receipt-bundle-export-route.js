'use strict';

/**
 * V4-B3 — Workbench receipt bundle export route contract.
 *
 * Path matching and status mapping only. Every product decision — which
 * workspace is readable, both ceilings, mandatory verification — belongs to
 * `receipt-bundle-exporter.js`, mirroring the inspector/route split the
 * existing Workbench routes already use.
 */

const { exportWorkbenchReceiptBundle } = require('./receipt-bundle-exporter');

const ROUTE_PATHNAME = '/api/workbench/receipt-bundle';

const STATUS_TO_HTTP = Object.freeze({
  exported: 200,
  invalid_request: 400,
  invalid: 409,
  limit_exceeded: 413,
  read_error: 502,
});

/**
 * Match the exact export path.
 *
 * A trailing slash is tolerated because the central auth policy normalizes it
 * the same way; anything else is not this route and must fall through so an
 * undeclared neighbour stays a 404 rather than becoming a 401.
 */
function parseWorkbenchReceiptBundlePath(pathname) {
  if (typeof pathname !== 'string') return null;
  const normalized = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
  if (normalized !== ROUTE_PATHNAME) return null;
  return { ok: true };
}

function handleWorkbenchReceiptBundleRequest({ workspaceId, source, exportBundle, exportedAt } = {}) {
  const outcome = exportWorkbenchReceiptBundle({ workspaceId, source, exportBundle, exportedAt });
  const statusCode = STATUS_TO_HTTP[outcome.status] || 502;
  return { statusCode, body: outcome };
}

module.exports = {
  ROUTE_PATHNAME,
  STATUS_TO_HTTP,
  parseWorkbenchReceiptBundlePath,
  handleWorkbenchReceiptBundleRequest,
};
