'use strict';

const { readReceiptById } = require('../receipt/receipt-read-index');
const { getReceiptFamilyById, getReceiptStamp } = require('../receipt/receipt-stamp');

const sourceIdentities = new WeakMap();
let nextSourceIdentity = 1;

/**
 * The complete set of `reason` values this inspector may return (#737).
 *
 * Raw error text used to reach the HTTP body verbatim, both from caught
 * exceptions (`error.message`) and from failed read results
 * (`read.error.message`). The receipt read path can surface validation,
 * persistence, serialization and driver errors, so that text could carry
 * filesystem paths, driver state, schema internals or fragments of malformed
 * stored content to any authenticated caller.
 *
 * This mirrors the vocabulary receipt-bundle-exporter.js already keeps: public
 * responses say which of a fixed set of things went wrong, and the underlying
 * error stays in the process log.
 */
const PUBLIC_REASONS = Object.freeze({
  RECEIPT_ID_REQUIRED: 'receiptId_required',
  RECEIPT_SOURCE_REQUIRED: 'receipt_source_required',
  RECEIPT_NOT_FOUND: 'receipt_not_found',
  RECEIPT_CHAIN_INVALID: 'receipt_chain_invalid',
  RECEIPT_READ_FAILED: 'receipt_read_failed',
});

/**
 * Record the underlying failure where operators can see it, and return only
 * the public reason. Never returns anything derived from `error`.
 */
function reportInternalReadFailure(receiptId, error) {
  console.error('[workbench-trust-receipt] read failed for %s:', receiptId, error);
  return PUBLIC_REASONS.RECEIPT_READ_FAILED;
}

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sourceMeta(extra = {}) {
  return {
    kind: 'trust_receipt_read_index',
    readOnly: true,
    ...extra,
  };
}

function sourceIdentity(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
  let identity = sourceIdentities.get(source);
  if (!identity) {
    const label = trimText(source.id) || trimText(source.memoryPath) || 'source';
    identity = `${label}#${nextSourceIdentity}`;
    nextSourceIdentity += 1;
    sourceIdentities.set(source, identity);
  }
  return identity;
}

function receiptSchemaFamily(source, receiptId, workspaceId, explicitFamily) {
  try {
    let family = trimText(explicitFamily);
    if (!family && typeof source.getReceiptFamilyById === 'function') {
      family = trimText(source.getReceiptFamilyById(receiptId));
    }
    if (!family && (source?._db || typeof source?._readJsonJournal === 'function')) {
      family = trimText(getReceiptFamilyById(source, receiptId, workspaceId));
    }
    if (!family && typeof source.getCommittedMutationReceiptById === 'function') {
      const committed = source.getCommittedMutationReceiptById(receiptId);
      family = committed?.canonicalPayload?.schemaVersion?.startsWith('v4-receipt-v')
        ? 'v4'
        : committed ? 'non-v4' : '';
    }
    return family === 'v4' || family === 'non-v4' ? family : '';
  } catch (_) {
    return '';
  }
}

function validationStamp(options, source, receiptId, workspaceId) {
  if (!options.cache || typeof options.cache.get !== 'function') return null;
  if (!workspaceId) return null;
  const sourceId = sourceIdentity(source);
  const schemaFamily = receiptSchemaFamily(source, receiptId, workspaceId, options.schemaFamily);
  if (!sourceId || !schemaFamily) return null;
  try {
    const state = typeof source?.getReceiptStamp === 'function'
      ? source.getReceiptStamp(workspaceId, schemaFamily)
      : source && (source._db || typeof source._readJsonJournal === 'function')
        ? getReceiptStamp(source, workspaceId, schemaFamily)
        : null;
    if (!state || typeof state !== 'object') return null;
    return {
      sourceId,
      workspaceId,
      schemaFamily,
      receiptId,
      generation: state.generation,
      receiptCount: state.receiptCount,
      headHash: state.headHash,
    };
  } catch (_) {
    // Caching is an optimization. An unavailable stamp must never affect the
    // canonical read path or turn an adapter error into a successful read.
    return null;
  }
}

function missingFieldsFor(result) {
  const optionalFields = [
    'reason',
    'actor',
    'action',
    'tool',
    'claim',
    'traceId',
    'timestamp',
  ];
  return optionalFields.filter((field) => trimText(result[field]) === '');
}

function normalizeFoundReceipt(readResult) {
  const receipt = clone(readResult.receipt);
  const canonicalPayload = clone(readResult.canonicalPayload);
  const chainedReceipt = clone(readResult.chainedReceipt);
  const auditEvent = clone(readResult.auditEvent);
  const metadata = receipt && typeof receipt.metadata === 'object' ? receipt.metadata : {};

  const normalized = {
    ok: true,
    status: 'found',
    receiptId: trimText(readResult.receiptId || receipt.receiptId),
    workspaceId: trimText(receipt.workspaceId || canonicalPayload.workspaceId),
    verdict: trimText(canonicalPayload.verdict),
    reason: trimText(canonicalPayload.reason || receipt.reason),
    actor: trimText(canonicalPayload.actor || receipt.actor),
    action: trimText(metadata.action || canonicalPayload.action || receipt.action),
    tool: trimText(metadata.tool || canonicalPayload.tool || receipt.tool),
    claim: trimText(metadata.claim || canonicalPayload.claim || receipt.claim),
    traceId: trimText(metadata.traceId || canonicalPayload.traceId || receipt.traceId),
    timestamp: trimText(canonicalPayload.createdAt || receipt.createdAt || auditEvent.timestamp),
    receipt,
    canonicalPayload,
    chainedReceipt,
    auditEvent,
    chainStatus: readResult.chainStatus || null,
    chainValidation: clone(readResult.chainValidation) || null,
    missingFields: [],
    source: sourceMeta({ chainValidated: readResult.chainStatus === 'valid' }),
  };
  normalized.missingFields = missingFieldsFor(normalized);
  return normalized;
}

function inspectTrustReceipt(options = {}) {
  const receiptId = trimText(options.receiptId);
  if (!receiptId) {
    return {
      ok: false,
      status: 'invalid_request',
      reason: PUBLIC_REASONS.RECEIPT_ID_REQUIRED,
      receiptId: null,
      missingFields: ['receiptId'],
      source: sourceMeta(),
    };
  }

  const source = options.source || options.graph;
  if (!source) {
    return {
      ok: false,
      status: 'read_error',
      reason: PUBLIC_REASONS.RECEIPT_SOURCE_REQUIRED,
      receiptId,
      missingFields: ['source'],
      source: sourceMeta(),
    };
  }

  const workspaceId = trimText(options.workspaceId);
  const filters = workspaceId ? { workspaceId } : {};
  const stamp = validationStamp(options, source, receiptId, workspaceId);
  if (stamp) {
    const cached = options.cache.get(stamp);
    if (cached && cached.receiptId === receiptId) return cached;
  }

  let read;
  try {
    read = options.readReceipt
      ? options.readReceipt(source, receiptId, filters)
      : readReceiptById(source, receiptId, filters);
  } catch (error) {
    return {
      ok: false,
      status: 'read_error',
      reason: reportInternalReadFailure(receiptId, error),
      receiptId,
      missingFields: [],
      source: sourceMeta(),
    };
  }

  if (!read || typeof read !== 'object') {
    return {
      ok: false,
      status: 'read_error',
      reason: PUBLIC_REASONS.RECEIPT_READ_FAILED,
      receiptId,
      missingFields: [],
      source: sourceMeta(),
    };
  }

  if (read.ok) {
    const normalized = normalizeFoundReceipt(read);
    if (stamp && options.cache && typeof options.cache.put === 'function') {
      options.cache.put(stamp, normalized);
    }
    return normalized;
  }

  if (read.status === 'invalid_request') {
    return {
      ok: false,
      status: 'invalid_request',
      reason: PUBLIC_REASONS.RECEIPT_ID_REQUIRED,
      receiptId: null,
      missingFields: ['receiptId'],
      source: sourceMeta(),
    };
  }

  // The receipt was located, but the chain it belongs to does not validate, so
  // it is reported as an integrity failure rather than a generic read error --
  // and never as a found receipt (#766).
  if (read.status === 'chain_invalid') {
    const invalid = {
      ok: false,
      status: 'chain_invalid',
      reason: PUBLIC_REASONS.RECEIPT_CHAIN_INVALID,
      receiptId,
      missingFields: [],
      source: sourceMeta(),
    };
    if (stamp && options.cache && typeof options.cache.put === 'function') {
      options.cache.put(stamp, invalid);
    }
    return invalid;
  }

  if (read.status === 'not_found') {
    return {
      ok: false,
      status: 'not_found',
      reason: PUBLIC_REASONS.RECEIPT_NOT_FOUND,
      receiptId,
      missingFields: [],
      source: sourceMeta(),
    };
  }

  return {
    ok: false,
    status: 'read_error',
    reason: reportInternalReadFailure(receiptId, read.error),
    receiptId,
    missingFields: [],
    source: sourceMeta(),
  };
}

module.exports = {
  PUBLIC_REASONS,
  inspectTrustReceipt,
};
