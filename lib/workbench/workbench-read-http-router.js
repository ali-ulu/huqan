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
const { readExactWorkspace } = require('../http/exact-workspace');

/**
 * Defensive headers for every Workbench read response (#738, #768).
 *
 * no-store, not no-cache: no-cache permits a cache to *store* the response and
 * only requires revalidation before reuse, so a trust-receipt body — which
 * carries the materialized receipt, canonical payload, chained receipt and
 * audit event — could persist in a browser or intermediary cache past logout
 * or session handoff. The trust-receipt route used no-cache while its
 * neighbours here already used no-store; there is no reason for it to differ.
 */
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
  // Still part of the constructor contract even though every response in this
  // router now goes through writeJson with MEMORY_HEADERS (#738, #768).
  requireFunction(options, 'writeApiError');
  const denyIfUnauthorized = requireFunction(options, 'denyIfUnauthorized');
  const readTrustFilters = requireFunction(options, 'readTrustFilters');
  const readReceiptById = requireFunction(options, 'readReceiptById');

  return function handleWorkbenchRead(req, res, reqUrl, graph) {
    const bundleRequest = parseWorkbenchReceiptBundlePath(reqUrl?.pathname);
    if (bundleRequest) {
      if (req.method !== 'GET') {
        writeJson(req, res, 405, {
          ok: false,
          status: 'method_not_allowed',
          error: { code: 'method_not_allowed', message: 'Method not allowed' },
        }, MEMORY_HEADERS);
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;

      const workspaceParam = readExactWorkspace(reqUrl?.searchParams);
      if (!workspaceParam.ok) {
        invalidMemoryRequest(writeJson, req, res, 'invalid_workspace_id');
        return true;
      }

      const { statusCode, body } = handleWorkbenchReceiptBundleRequest({
        workspaceId: workspaceParam.workspaceId,
        source: graph,
      });
      writeJson(req, res, statusCode, body, MEMORY_HEADERS);
      return true;
    }

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

    const receiptRequest = parseWorkbenchTrustReceiptPath(reqUrl?.pathname);
    if (!receiptRequest) return false;

    if (req.method !== 'GET') {
      writeJson(req, res, 405, {
        ok: false,
        status: 'method_not_allowed',
        error: { code: 'method_not_allowed', message: 'Method not allowed' },
      }, MEMORY_HEADERS);
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
      }, MEMORY_HEADERS);
      return true;
    }

    const workspace = readExactWorkspace(reqUrl?.searchParams);
    if (!workspace.ok) {
      writeJson(req, res, 400, {
        ok: false,
        status: 'invalid_request',
        error: { code: workspace.code, message: 'Exactly one non-empty workspaceId is required.' },
      }, MEMORY_HEADERS);
      return true;
    }
    const filters = readTrustFilters(reqUrl);
    const { statusCode, body } = handleWorkbenchTrustReceiptRequest({
      receiptId: receiptRequest.receiptId,
      workspaceId: workspace.workspaceId,
      source: graph,
      readReceipt: (source, receiptId, readFilters) => (
        readReceiptById(source, receiptId, readFilters)
      ),
    });
    writeJson(req, res, statusCode, body, MEMORY_HEADERS);
    return true;
  };
}

module.exports = {
  createWorkbenchReadHttpRouter,
};
