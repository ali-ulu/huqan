'use strict';

// V4-B3 pure route contract for the receipt-bundle export.
//
// Path and method parsing plus status mapping only. Every export decision
// belongs to lib/workbench/receipt-bundle-exporter.js.

const { exportReceiptBundle } = require('./receipt-bundle-exporter');

const ROUTE_PATH = '/api/workbench/receipt-bundle';
const MAX_WORKSPACE_ID_LEN = 128;

function parseWorkbenchReceiptBundlePath(pathname) {
  if (typeof pathname !== 'string') return null;
  const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return normalized === ROUTE_PATH ? { ok: true } : null;
}

// The raw query value is handed to the owner uncoerced. Only an
// over-long value is rejected here, before it reaches the exact-match
// comparison, so padded and mis-cased values still fail closed in the owner
// rather than being silently normalised on the way in.
function readWorkspaceParam(reqUrl) {
  const raw = reqUrl && reqUrl.searchParams ? reqUrl.searchParams.get('workspaceId') : null;
  if (raw === null) return { ok: true, workspaceId: undefined };
  if (raw.length > MAX_WORKSPACE_ID_LEN) {
    return { ok: false, status: 400, error: { code: 'WORKSPACE_UNSUPPORTED', message: 'this export surface binds the canonical default workspace only' } };
  }
  return { ok: true, workspaceId: raw };
}

function handleWorkbenchReceiptBundleRequest({ reqUrl, source }) {
  const workspace = readWorkspaceParam(reqUrl);
  if (!workspace.ok) {
    return { status: workspace.status, body: { ok: false, status: 'invalid_request', error: workspace.error } };
  }

  const result = exportReceiptBundle({ source, workspaceId: workspace.workspaceId });
  if (!result.ok) {
    return { status: result.status, body: { ok: false, status: 'export_refused', error: result.error } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      status: 'exported',
      data: {
        workspaceId: result.workspaceId,
        receiptCount: result.receiptCount,
        serializedBytes: result.serializedBytes,
        chainStatus: result.chainStatus,
        bundle: result.bundle,
      },
    },
  };
}

module.exports = {
  ROUTE_PATH,
  parseWorkbenchReceiptBundlePath,
  handleWorkbenchReceiptBundleRequest,
};
