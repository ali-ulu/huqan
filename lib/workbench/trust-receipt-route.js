'use strict';

const { inspectTrustReceipt } = require('./trust-receipt-inspector');

const ROUTE_PREFIX = '/api/workbench/trust-receipt/';
const MAX_RECEIPT_ID_LEN = 128;
const MAX_WORKSPACE_ID_LEN = 128;

// #1301: this range used to skip \x09 (tab), \x0A (LF) and \x0D (CR), so a
// receiptId/workspaceId carrying an embedded newline passed through
// unstripped and reached the process log verbatim via
// trust-receipt-inspector.js's console.error() -- log-line injection. Strip
// the full control-character range, matching memory-context-route.js's
// CONTROL_CHARACTERS coverage on the sibling read route.
function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLen).replace(/[\x00-\x1F\x7F]/g, '').trim();
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
  // The receipt exists; its chain does not validate (#766).
  chain_invalid: 409,
  read_error: 502,
};

function handleWorkbenchTrustReceiptRequest({ receiptId, workspaceId, source, readReceipt, cache }) {
  // #1301: receiptId normally already went through sanitize() inside
  // parseWorkbenchTrustReceiptPath() above, but this function is a public
  // module export in its own right -- sanitize it here too, the same way
  // workspaceId already is, instead of relying entirely on the one call site
  // that happens to do it first.
  const inspection = inspectTrustReceipt({
    receiptId: sanitize(receiptId, MAX_RECEIPT_ID_LEN),
    workspaceId: sanitize(workspaceId, MAX_WORKSPACE_ID_LEN) || undefined,
    source,
    readReceipt,
    cache,
  });
  const statusCode = STATUS_TO_HTTP[inspection.status] || 502;
  return { statusCode, body: inspection };
}

module.exports = {
  ROUTE_PREFIX,
  parseWorkbenchTrustReceiptPath,
  handleWorkbenchTrustReceiptRequest,
};
