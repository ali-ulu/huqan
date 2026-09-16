'use strict';

/**
 * V4-B3 — Workbench receipt bundle export route contract.
 *
 * Path/method parsing and status mapping only. All product decisions —
 * canonical workspace resolution, mandatory verification and both ceilings —
 * belong to `receipt-bundle-exporter.js`.
 */

const { exportWorkbenchReceiptBundle } = require('./receipt-bundle-exporter');

const ROUTE_PATH = '/api/workbench/receipt-bundle';

const STATUS_TO_HTTP = Object.freeze({
  exported: 200,
  invalid_request: 400,
  invalid_chain: 409,
  verification_failed: 409,
  ceiling_exceeded: 413,
  read_error: 502,
});

function parseWorkbenchReceiptBundlePath(pathname) {
  if (typeof pathname !== 'string') return null;
  const normalized = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
  return normalized === ROUTE_PATH ? { ok: true } : null;
}

/**
 * Read the caller-supplied workspace exactly as given.
 *
 * Omitted stays `undefined` so the exporter can apply canonical `default`. A
 * supplied value is passed through untrimmed and uncoerced so the exporter can
 * fail it closed. Repeating the parameter is itself invalid.
 */
function readWorkspaceParam(searchParams) {
  if (!searchParams || typeof searchParams.getAll !== 'function') return { ok: true };
  const values = searchParams.getAll('workspaceId');
  if (values.length === 0) return { ok: true };
  if (values.length > 1) return { ok: false, code: 'invalid_workspace_id' };
  return { ok: true, workspaceId: values[0] };
}

function handleWorkbenchReceiptBundleRequest(options = {}) {
  const workspace = readWorkspaceParam(options.searchParams);
  if (!workspace.ok) {
    return {
      statusCode: 400,
      body: { ok: false, status: 'invalid_request', error: { code: workspace.code } },
    };
  }

  const result = exportWorkbenchReceiptBundle({
    workspaceId: Object.prototype.hasOwnProperty.call(workspace, 'workspaceId')
      ? workspace.workspaceId
      : undefined,
    auditOwner: options.auditOwner,
  });

  if (result.ok !== true) {
    return {
      statusCode: STATUS_TO_HTTP[result.status] || 502,
      body: { ok: false, status: result.status, error: result.error },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      status: 'exported',
      bundle: result.bundle,
    },
  };
}

module.exports = {
  ROUTE_PATH,
  STATUS_TO_HTTP,
  parseWorkbenchReceiptBundlePath,
  handleWorkbenchReceiptBundleRequest,
};
