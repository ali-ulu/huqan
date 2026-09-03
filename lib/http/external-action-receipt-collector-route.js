'use strict';

const { ingestReceiptBatch } = require('../external-action-receipt-collector');
const { writeApiError, writeJson } = require('../server-response-helpers');

const RECEIPT_BATCH_PATH = '/api/v5/receipts/batches';
const MAX_RECEIPT_BATCH_BYTES = 1_048_576;

function createExternalActionReceiptCollectorRoute({
  parseJsonRequest,
  collectorRoot,
  ingestReceiptBatchFn = ingestReceiptBatch,
} = {}) {
  if (typeof parseJsonRequest !== 'function') throw new TypeError('parseJsonRequest must be a function');
  if (typeof collectorRoot !== 'string' || !collectorRoot.trim()) throw new TypeError('collectorRoot must be a non-empty string');
  if (typeof ingestReceiptBatchFn !== 'function') throw new TypeError('ingestReceiptBatchFn must be a function');

  return async function handleExternalActionReceiptCollectorRoute(req, res, reqUrl) {
    if (reqUrl.pathname !== RECEIPT_BATCH_PATH) return false;
    if (req.method !== 'POST') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return true;
    }

    let batch;
    try { batch = await parseJsonRequest(req, res, { maxBytes: MAX_RECEIPT_BATCH_BYTES }); } catch (_) { return true; }
    if (batch === undefined || batch === null) return true;

    let result;
    try { result = ingestReceiptBatchFn({ batch, root: collectorRoot }); } catch (_) {
      writeApiError(req, res, 503, 'RECEIPT_COLLECTOR_UNAVAILABLE', 'Receipt collector is temporarily unavailable.');
      return true;
    }
    if (!result || result.ok !== true) {
      const statusCode = result?.status === 'limit_exceeded' ? 413 : 400;
      writeApiError(req, res, statusCode, 'RECEIPT_BATCH_REJECTED', 'Receipt batch was rejected.', {
        reason: String(result?.error?.code || 'collector_rejected'),
      });
      return true;
    }

    writeJson(req, res, result.status === 'stored' ? 202 : 200, {
      ok: true, status: result.status, batchId: result.batchId, stored: result.stored, tenant: result.tenant,
    }, { 'Cache-Control': 'no-store' });
    return true;
  };
}

module.exports = { RECEIPT_BATCH_PATH, MAX_RECEIPT_BATCH_BYTES, createExternalActionReceiptCollectorRoute };
