const { readReceiptById } = require('../receipt/receipt-read-index');
const { receiptReadFailure } = require('./receipt-read-failures');
const { readExactWorkspace } = require('./exact-workspace');
const { readTrustFilters, readPathReceiptId } = require('../http-trust-query');

function createReceiptReadRoute({
  graph,
  denyIfUnauthorized,
  writeJson,
  writeApiError,
}) {
  return function handleReceiptReadRoute(req, res, reqUrl) {
    const receiptReadRequest = readPathReceiptId(reqUrl.pathname);
    if (!receiptReadRequest) return false;
    if (req.method !== 'GET') {
      writeApiError(req, res, 405, 'method_not_allowed', 'Method not allowed');
      return true;
    }
    if (!denyIfUnauthorized(req, res)) return true;
    if (!receiptReadRequest.ok) {
      writeJson(req, res, 400, {
        ok: false,
        error: {
          code: receiptReadRequest.code,
          message: receiptReadRequest.code === 'missing_receipt_id'
            ? 'receiptId is required'
            : 'receiptId must be a non-empty string',
        },
      }, { 'Cache-Control': 'no-cache' });
      return true;
    }
    const workspace = readExactWorkspace(reqUrl.searchParams);
    if (!workspace.ok) {
      writeApiError(
        req,
        res,
        400,
        workspace.code,
        'Exactly one non-empty workspaceId is required.',
      );
      return true;
    }
    const filters = readTrustFilters(reqUrl);
    const readFilters = { workspaceId: workspace.workspaceId };
    const read = readReceiptById(graph, receiptReadRequest.receiptId, readFilters);
    if (!read.ok) {
      const failure = receiptReadFailure(read.status);
      writeJson(req, res, failure.statusCode, {
        ok: false,
        error: {
          code: failure.code,
          message: read.error?.message || 'receipt could not be read',
        },
      }, { 'Cache-Control': 'no-cache' });
      return true;
    }
    writeJson(req, res, 200, {
      ok: true,
      receipt: read.receipt,
    }, { 'Cache-Control': 'no-cache' });
    return true;
  };
}

module.exports = { createReceiptReadRoute };
