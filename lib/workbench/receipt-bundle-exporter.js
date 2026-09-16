'use strict';

/**
 * V4-B3 — Workbench receipt bundle export owner.
 *
 * Owns canonical workspace resolution, the single
 * `exportMaterializedReceiptBundle()` call, the mandatory
 * `verifyExportedBundle()` gate, both ceilings, and bounded outcome mapping.
 * It returns bounded outcomes only; it never writes an HTTP response and never
 * surfaces a raw exception, stack or Graph row.
 *
 * ## Bounded receipt export guard, not a bounded reader
 *
 * `createBoundedReceiptExportGuard()` is deliberately NOT named a bounded
 * reader or a proxy reader. It does not make the underlying storage read
 * bounded, and nothing here should ever be read as a claim that it does.
 *
 * Residual limitation: `getAuditEvents()` currently performs an unbounded
 * underlying read — `graph.js` resolves it through `allAuditEvents.all()` and
 * filters in memory, and no layer accepts a limit. V4-B3 does not introduce a
 * bounded storage read primitive because the authorized scope excludes
 * graph/audit storage changes.
 *
 * What the guard does enforce is that the export boundary reaches a fail-closed
 * trust decision *before* the expensive expansion:
 *
 *   graph.getAuditEvents()      unbounded read      (pre-existing, out of scope)
 *          |
 *   distinct receiptId count    read-only, early-exit at the ceiling
 *          |
 *   fail closed 413             before receipt deep cloning,
 *                               before chain expansion,
 *                               before serialization,
 *                               before hashing
 *
 * A future storage-layer bounded iterator may improve resource efficiency but
 * is outside this scope. This matches the sibling Workbench read owner
 * `memory-context-audit-source.js`, which also reads first, then fails closed.
 */

const { exportMaterializedReceiptBundle } = require('../receipt/receipt-read-index');
const { verifyExportedBundle } = require('../receipt/receipt-export');

const CANONICAL_WORKSPACE_ID = 'default';
const MAX_RECEIPTS = 1024;
const MAX_SERIALIZED_BUNDLE_BYTES = 2 * 1024 * 1024;

const GUARD_ERROR = 'ReceiptBundleExportGuardError';
const CEILING_EXCEEDED = 'RECEIPT_COUNT_CEILING_EXCEEDED';
const INVALID_AUDIT_RESULT = 'INVALID_AUDIT_SOURCE_RESULT';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function guardError(code) {
  const error = new Error(code);
  error.name = GUARD_ERROR;
  error.code = code;
  return error;
}

function outcome(status, code) {
  return { ok: false, status, error: { code } };
}

/**
 * Resolve the canonical workspace. Omitted means `default`; a supplied value
 * must be the exact string `default`. Values are not trimmed or coerced first,
 * so padded, differently cased, blank, numeric, boolean, array and object forms
 * all fail closed here — before any read.
 */
function resolveCanonicalWorkspace(workspaceId) {
  if (workspaceId === undefined || workspaceId === null) {
    return { ok: true, workspaceId: CANONICAL_WORKSPACE_ID };
  }
  if (workspaceId !== CANONICAL_WORKSPACE_ID) {
    return { ok: false, code: 'invalid_workspace_id' };
  }
  return { ok: true, workspaceId: CANONICAL_WORKSPACE_ID };
}

/**
 * Count distinct materialized receiptIds without cloning anything, using the
 * same predicate `collectMaterializedReceiptEntries()` applies, so the count
 * agrees exactly with what the export would materialize. Exits as soon as the
 * ceiling is passed.
 */
function countDistinctReceiptIds(events) {
  const seen = new Set();
  for (const event of events) {
    const receipt = event && event.details && event.details.receipt;
    if (!isPlainObject(receipt)) continue;
    const receiptId = receipt.receiptId === undefined || receipt.receiptId === null
      ? ''
      : String(receipt.receiptId).trim();
    if (!receiptId) continue;
    seen.add(receiptId);
    if (seen.size > MAX_RECEIPTS) return seen.size;
  }
  return seen.size;
}

/**
 * Wrap an audit owner so the receipt-count ceiling is decided before the read
 * index clones, chains or serializes anything. See the module header for why
 * this is a guard rather than a bounded reader.
 */
function createBoundedReceiptExportGuard(auditOwner) {
  if (!auditOwner || typeof auditOwner.getAuditEvents !== 'function') {
    throw guardError('INVALID_AUDIT_OWNER');
  }
  return Object.freeze({
    getAuditEvents(filters) {
      const events = auditOwner.getAuditEvents(filters);
      if (!Array.isArray(events)) throw guardError(INVALID_AUDIT_RESULT);
      if (countDistinctReceiptIds(events) > MAX_RECEIPTS) throw guardError(CEILING_EXCEEDED);
      return events;
    },
  });
}

function classifyThrown(error) {
  if (error && error.name === GUARD_ERROR && error.code === CEILING_EXCEEDED) {
    return outcome('ceiling_exceeded', 'receipt_count_ceiling_exceeded');
  }
  return outcome('read_error', 'receipt_bundle_read_failed');
}

/**
 * Export a verified, bounded receipt bundle for the canonical workspace.
 *
 * @returns {{ ok: true, status: 'exported', bundle: object, serializedBytes: number }
 *          | { ok: false, status: string, error: { code: string } }}
 */
function exportWorkbenchReceiptBundle(options = {}) {
  const workspace = resolveCanonicalWorkspace(options.workspaceId);
  if (!workspace.ok) return outcome('invalid_request', workspace.code);

  let guard;
  try {
    guard = createBoundedReceiptExportGuard(options.auditOwner);
  } catch (_error) {
    return outcome('read_error', 'receipt_bundle_read_failed');
  }

  let exported;
  try {
    exported = exportMaterializedReceiptBundle(guard, { workspaceId: workspace.workspaceId });
  } catch (error) {
    return classifyThrown(error);
  }

  // A broken or tampered chain never becomes a bundle.
  if (!exported || exported.ok !== true || !isPlainObject(exported.bundle)) {
    return outcome('invalid_chain', 'receipt_chain_invalid');
  }

  // Mandatory verification, before any response body is written. A failed
  // verification returns no bundle — not partial, not unverified, not flagged.
  let verification;
  try {
    verification = verifyExportedBundle(exported.bundle);
  } catch (_error) {
    return outcome('verification_failed', 'receipt_bundle_verification_failed');
  }
  if (!verification || verification.valid !== true) {
    return outcome('verification_failed', 'receipt_bundle_verification_failed');
  }

  // Byte accounting uses the actual serialized UTF-8 bytes that would be sent,
  // not an estimate derived from receipt count. Serialization here is bounded
  // by the count ceiling already enforced above.
  let serialized;
  try {
    serialized = JSON.stringify(exported.bundle);
  } catch (_error) {
    return outcome('read_error', 'receipt_bundle_read_failed');
  }
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (serializedBytes > MAX_SERIALIZED_BUNDLE_BYTES) {
    return outcome('ceiling_exceeded', 'receipt_bundle_byte_ceiling_exceeded');
  }

  return {
    ok: true,
    status: 'exported',
    bundle: exported.bundle,
    serializedBytes,
  };
}

module.exports = {
  CANONICAL_WORKSPACE_ID,
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  createBoundedReceiptExportGuard,
  exportWorkbenchReceiptBundle,
  resolveCanonicalWorkspace,
};
