'use strict';

const { inspectTrustReceipt } = require('./trust-receipt-inspector');

const ROUTE_PREFIX = '/api/workbench/trust-receipt/';
const MAX_RECEIPT_ID_LEN = 128;
const MAX_WORKSPACE_ID_LEN = 128;

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

function parseWorkbenchTrustReceiptPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(ROUTE_PREFIX)) return null;
  const rawReceiptId = pathname.slice(ROUTE_PREFIX.length);
  if (!rawReceiptId) return { ok: false, code: 'missing_receipt_id', receiptId: '' };
  let decoded;
  try {
    decoded = decodeURIComponent(rawReceiptId);
  } catch (_error) {
    return { ok: false, code: 'invalid_receipt_id', receiptId: '' };
  }
  const receiptId = sanitize(decoded, MAX_RECEIPT_ID_LEN);
  if (!receiptId) return { ok: false, code: 'invalid_receipt_id', receiptId: '' };
  return { ok: true, receiptId };
}

const STATUS_TO_HTTP = {
  found: 200,
  not_found: 404,
  invalid_request: 400,
  read_error: 502,
};

function handleWorkbenchTrustReceiptRequest({ receiptId, workspaceId, source, readReceipt }) {
  const inspection = inspectTrustReceipt({
    receiptId,
    workspaceId: sanitize(workspaceId, MAX_WORKSPACE_ID_LEN) || undefined,
    source,
    readReceipt,
  });
  const statusCode = STATUS_TO_HTTP[inspection.status] || 502;
  return { statusCode, body: inspection };
}

module.exports = {
  ROUTE_PREFIX,
  parseWorkbenchTrustReceiptPath,
  handleWorkbenchTrustReceiptRequest,
};
