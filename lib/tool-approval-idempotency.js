'use strict';

const IDEMPOTENCY_CONTEXT_KEY = '__huqanApprovalIdempotency';
const IDEMPOTENCY_CONTEXT_VERSION = 'huqan.tool-approval-idempotency.v1';
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

function failure(code, error, extras = {}) {
  return { ok: false, code, error, ...extras };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeApprovalKey(value) {
  const key = String(value == null ? '' : value).trim();
  if (!key || key.length > 512 || /[\u0000-\u001f\u007f]/u.test(key)) return '';
  return key;
}

function normalizeFingerprint(value) {
  const fingerprint = String(value == null ? '' : value).trim();
  return SHA256_FINGERPRINT.test(fingerprint) ? fingerprint : '';
}

function expectedMarker(fingerprint) {
  return {
    version: IDEMPOTENCY_CONTEXT_VERSION,
    fingerprint,
  };
}

function markerMatches(marker, fingerprint) {
  return isPlainObject(marker)
    && Object.keys(marker).length === 2
    && marker.version === IDEMPOTENCY_CONTEXT_VERSION
    && marker.fingerprint === fingerprint;
}

function saveToolApprovalWithIdempotencyConflict(store, record = {}, fingerprintValue = '') {
  if (!store || typeof store.saveToolApprovalIfAbsent !== 'function') {
    return failure('APPROVAL_STORE_REQUIRED', 'a persistent approval store is required');
  }

  const approvalKey = normalizeApprovalKey(record.approvalKey);
  if (!approvalKey) {
    return failure('APPROVAL_KEY_REQUIRED', 'an explicit bounded approvalKey is required');
  }

  const fingerprint = normalizeFingerprint(fingerprintValue);
  if (!fingerprint) {
    return failure('APPROVAL_FINGERPRINT_INVALID', 'a lowercase sha256 fingerprint is required');
  }

  const suppliedContext = record.context == null ? {} : record.context;
  if (!isPlainObject(suppliedContext)) {
    return failure('APPROVAL_CONTEXT_INVALID', 'approval context must be a plain object');
  }
  if (Object.prototype.hasOwnProperty.call(suppliedContext, IDEMPOTENCY_CONTEXT_KEY)) {
    return failure('APPROVAL_CONTEXT_RESERVED', `${IDEMPOTENCY_CONTEXT_KEY} is reserved for storage identity enforcement`);
  }

  const expectedTool = String(record.tool || '');
  const expectedInput = String(record.input || '');
  const context = {
    ...suppliedContext,
    [IDEMPOTENCY_CONTEXT_KEY]: expectedMarker(fingerprint),
  };
  const saved = store.saveToolApprovalIfAbsent({
    ...record,
    approvalKey,
    context,
  });
  const approval = saved?.approval || null;

  if (!approval) {
    return failure('APPROVAL_STORE_RESULT_INVALID', 'approval store did not return a persisted approval');
  }
  if (saved.inserted === true) {
    return {
      ok: true,
      inserted: true,
      idempotent: false,
      conflict: false,
      fingerprint,
      approval,
    };
  }

  const existingMarker = approval.context?.[IDEMPOTENCY_CONTEXT_KEY];
  if (
    markerMatches(existingMarker, fingerprint)
    && approval.tool === expectedTool
    && approval.input === expectedInput
  ) {
    return {
      ok: true,
      inserted: false,
      idempotent: true,
      conflict: false,
      fingerprint,
      approval,
    };
  }

  return failure(
    'APPROVAL_IDEMPOTENCY_CONFLICT',
    'approvalKey already exists with a different or unverifiable reviewed payload fingerprint',
    {
      inserted: false,
      idempotent: false,
      conflict: true,
      fingerprint,
      approval,
    },
  );
}

module.exports = {
  IDEMPOTENCY_CONTEXT_KEY,
  IDEMPOTENCY_CONTEXT_VERSION,
  saveToolApprovalWithIdempotencyConflict,
};
