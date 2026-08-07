'use strict';

const {
  parseWorkbenchTrustReceiptPath,
  handleWorkbenchTrustReceiptRequest,
} = require('./trust-receipt-route');
const {
  parseWorkbenchMemoryContextPath,
  handleWorkbenchMemoryContextRequest,
} = require('./memory-context-route');
const {
  parseWorkbenchReceiptBundlePath,
  handleWorkbenchReceiptBundleRequest,
} = require('./receipt-bundle-export-route');

const MEMORY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function requireFunction(options, name) {
  if (typeof options[name] !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return options[name];
}

function invalidMemoryRequest(writeJson, req, res, code) {
  writeJson(req, res, 400, {
    ok: false,
    status: 'invalid_request',
    error: { code },
  }, MEMORY_HEADERS);
}

function createWorkbenchReadHttpRouter(options = {}) {
  const writeJson = requireFunction(options, 'writeJson');
  const writeApiError = requireFunction(options, 'writeApiError');
  const denyIfUnauthorized = requireFunction(options, 'denyIfUnauthorized');
  const readTrustFilters = requireFunction(options, 'readTrustFilters');
  const readReceiptById = requireFunction(options, 'readReceiptById');

  return function handleWorkbenchRead(req, res, reqUrl, graph) {
    const memoryRequest = parseWorkbenchMemoryContextPath(reqUrl?.pathname);
    if (memoryRequest) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (req.method !== 'GET') {
        writeJson(req, res, 405, {
          ok: false,
          error: {
            code: 'method_not_allowed',
            message: 'Method not allowed',
          },
        }, MEMORY_HEADERS);
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      if (!memoryRequest.ok) {
        invalidMemoryRequest(writeJson, req, res, memoryRequest.code);
        return true;
      }

      const workspaceValues = reqUrl.searchParams.getAll('workspaceId');
      if (workspaceValues.length > 1) {
        invalidMemoryRequest(writeJson, req, res, 'invalid_workspace_id');
        return true;
      }

      const { statusCode, body } = handleWorkbenchMemoryContextRequest({
        recordId: memoryRequest.recordId,
        workspaceId: workspaceValues.length === 1 ? workspaceValues[0] : '',
        auditOwner: graph,
      });
      writeJson(req, res, statusCode, body, MEMORY_HEADERS);
      return true;
    }

    // V4-B3 receipt bundle export. MEMORY_HEADERS carries the no-store /
    // nosniff pair required on every response of this route, success or not.
    if (parseWorkbenchReceiptBundlePath(reqUrl?.pathname)) {
      if (req.method !== 'GET') {
        writeJson(req, res, 405, {
          ok: false,
          status: 'invalid_request',
          error: { code: 'method_not_allowed', message: 'Method not allowed' },
        }, MEMORY_HEADERS);
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;

      const { status, body } = handleWorkbenchReceiptBundleRequest({ reqUrl, source: graph });
      writeJson(req, res, status, body, MEMORY_HEADERS);
      return true;
    }

    const receiptRequest = parseWorkbenchTrustReceiptPath(reqUrl?.pathname);
    if (!receiptRequest) return false;

    if (req.method !== 'GET') {
      writeApiError(req, res, 405, 'method_not_allowed', 'Method not allowed');
      return true;
    }
    if (!denyIfUnauthorized(req, res)) return true;
    if (!receiptRequest.ok) {
      writeJson(req, res, 400, {
        ok: false,
        status: 'invalid_request',
        error: {
          code: receiptRequest.code,
          message: receiptRequest.code === 'missing_receipt_id'
            ? 'receiptId is required'
            : 'receiptId must be a non-empty string',
        },
      }, { 'Cache-Control': 'no-cache' });
      return true;
    }

    const filters = readTrustFilters(reqUrl);
    const { statusCode, body } = handleWorkbenchTrustReceiptRequest({
      receiptId: receiptRequest.receiptId,
      workspaceId: filters.workspaceId,
      source: graph,
      readReceipt: (source, receiptId, readFilters) => (
        readReceiptById(source, receiptId, readFilters)
      ),
    });
    writeJson(req, res, statusCode, body, { 'Cache-Control': 'no-cache' });
    return true;
  };
}

module.exports = {
  createWorkbenchReadHttpRouter,
};
