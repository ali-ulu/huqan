'use strict';

// V4-B3 bounded receipt-bundle export owner.
//
// exportMaterializedReceiptBundle() already builds a materialized chain and
// returns a bundle that verifyExportedBundle() validates, but nothing in
// production called it. This owner makes it reachable under the authorized
// bounds.
//
// Ordering matters and is the whole point of this module: the receipt count is
// established BEFORE the export primitive runs. The primitive clones every
// matching receipt and builds the entire chain before anything is serializable,
// so checking the ceiling afterwards would mean the work is already done. When
// the count ceiling is exceeded the export primitive is never called.
//
// Honest limit: the underlying audit read is unbounded. graph.getAuditEvents()
// takes no limit and loads the whole audit table, and lib/audit-log.js filters
// in memory. lib/workbench/memory-context-audit-source.js -- the sibling
// Workbench read owner shipped in V4-B1 -- has the same exposure and resolves it
// the same way, with a fail-closed scan limit over the returned array. B3
// inherits that exposure rather than introducing it, and bounding the read
// itself would require changing lib/receipt or graph.js, which is out of scope.

const { exportMaterializedReceiptBundle } = require('../receipt/receipt-read-index');
const { verifyExportedBundle } = require('../receipt/receipt-export');

const CANONICAL_WORKSPACE_ID = 'default';
const MAX_RECEIPTS = 1024;
const MAX_SERIALIZED_BUNDLE_BYTES = 2 * 1024 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failure(status, code, message) {
  return { ok: false, status, error: { code, message } };
}

// Absent means canonical. A supplied value must be the exact string; nothing is
// trimmed or coerced first, so padded and non-string identities fail closed.
function resolveCanonicalWorkspace(value) {
  if (value === undefined || value === null) return { ok: true, workspaceId: CANONICAL_WORKSPACE_ID };
  if (value === CANONICAL_WORKSPACE_ID) return { ok: true, workspaceId: CANONICAL_WORKSPACE_ID };
  return failure(400, 'WORKSPACE_UNSUPPORTED', 'this export surface binds the canonical default workspace only');
}

// Mirrors the receipt-bearing filter inside collectMaterializedReceiptEntries
// without cloning anything, so the ceiling can be decided before the export
// primitive materializes the chain.
function countReceiptBearingEvents(source, workspaceId) {
  let events;
  try {
    events = source.getAuditEvents({ workspaceId });
  } catch (_) {
    return failure(502, 'RECEIPT_SOURCE_UNAVAILABLE', 'receipt source could not be read');
  }
  if (!Array.isArray(events)) {
    return failure(502, 'RECEIPT_SOURCE_UNAVAILABLE', 'receipt source did not return an event list');
  }

  const seen = new Set();
  for (const event of events) {
    const receipt = event && event.details && event.details.receipt;
    if (!isPlainObject(receipt)) continue;
    const receiptId = typeof receipt.receiptId === 'string' ? receipt.receiptId.trim() : '';
    if (!receiptId || seen.has(receiptId)) continue;
    seen.add(receiptId);
    if (seen.size > MAX_RECEIPTS) {
      return failure(413, 'RECEIPT_COUNT_CEILING_EXCEEDED', `receipt bundle exceeds the ${MAX_RECEIPTS} receipt ceiling`);
    }
  }
  return { ok: true, count: seen.size };
}

// Sums per-receipt serialized bytes first and abandons as soon as the ceiling is
// passed, so an oversized bundle is never assembled into one string. Only a
// bundle already known to fit is serialized whole, and the exact serialized
// UTF-8 length of that payload is what the ceiling is finally checked against.
function measureSerializedBundle(bundle) {
  let running = 0;
  for (const receipt of bundle.receipts) {
    running += Buffer.byteLength(JSON.stringify(receipt), 'utf8');
    if (running > MAX_SERIALIZED_BUNDLE_BYTES) return { ok: false };
  }
  const serialized = JSON.stringify(bundle);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_SERIALIZED_BUNDLE_BYTES) return { ok: false };
  return { ok: true, bytes };
}

function exportReceiptBundle({ source, workspaceId } = {}) {
  if (!source || typeof source.getAuditEvents !== 'function') {
    return failure(502, 'RECEIPT_SOURCE_UNAVAILABLE', 'receipt source is unavailable');
  }

  const workspace = resolveCanonicalWorkspace(workspaceId);
  if (!workspace.ok) return workspace;

  const counted = countReceiptBearingEvents(source, workspace.workspaceId);
  if (!counted.ok) return counted;

  let exported;
  try {
    exported = exportMaterializedReceiptBundle(source, { workspaceId: workspace.workspaceId });
  } catch (_) {
    return failure(502, 'RECEIPT_SOURCE_UNAVAILABLE', 'receipt bundle could not be built');
  }
  if (!exported || exported.ok !== true || !isPlainObject(exported.bundle) || !Array.isArray(exported.bundle.receipts)) {
    return failure(409, 'RECEIPT_CHAIN_INVALID', 'receipt chain did not validate and no bundle was produced');
  }

  // The count was taken before materialization; re-check the realised bundle so
  // a source that grew in between still fails closed.
  if (exported.bundle.receipts.length > MAX_RECEIPTS) {
    return failure(413, 'RECEIPT_COUNT_CEILING_EXCEEDED', `receipt bundle exceeds the ${MAX_RECEIPTS} receipt ceiling`);
  }

  const measured = measureSerializedBundle(exported.bundle);
  if (!measured.ok) {
    return failure(413, 'RECEIPT_BYTE_CEILING_EXCEEDED', 'receipt bundle exceeds the serialized byte ceiling');
  }

  let verification;
  try {
    verification = verifyExportedBundle(exported.bundle);
  } catch (_) {
    return failure(409, 'BUNDLE_VERIFICATION_FAILED', 'receipt bundle verification failed and no bundle was returned');
  }
  if (!verification || verification.valid !== true) {
    return failure(409, 'BUNDLE_VERIFICATION_FAILED', 'receipt bundle verification failed and no bundle was returned');
  }

  return {
    ok: true,
    status: 200,
    workspaceId: workspace.workspaceId,
    receiptCount: exported.bundle.receipts.length,
    serializedBytes: measured.bytes,
    chainStatus: exported.chainStatus && exported.chainStatus.valid ? 'valid' : 'invalid',
    bundle: exported.bundle,
  };
}

module.exports = {
  CANONICAL_WORKSPACE_ID,
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  exportReceiptBundle,
  resolveCanonicalWorkspace,
};

// Internal seams, exposed for tests only, following the plugins/company-brain.js
// precedent. The byte ceiling cannot be reached through the real admission path:
// canonical receipts are field-bounded at roughly 729 bytes regardless of input
// size, so 1024 of them is about 728 KiB against a 2 MiB ceiling. That is the
// intended relationship -- count binds, bytes guard anomalies -- but it means
// the byte guard has to be proved here rather than through a synthetic
// end-to-end request that could not occur.
module.exports._test = {
  countReceiptBearingEvents,
  measureSerializedBundle,
};
