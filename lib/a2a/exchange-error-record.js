'use strict';

/**
 * Typed exchange error records (R25, #3480).
 *
 * An exchange outcome already carries a reason string, but a string alone
 * cannot answer the two questions an operator asks after a refusal: what kind
 * of failure was this, and is it safe to retry. This module binds those
 * answers into one record — `{error_type, error_message, traceback_hash}` —
 * without ever storing the raw traceback.
 *
 * The type vocabulary is not invented here: it is exactly the evaluator
 * reason set the bounded exchange already returns
 * (`RETRYABLE_EVALUATOR_REASONS` plus the three terminal codes the exchange
 * and its route produce: `replay_detected`, `verification_failed`,
 * `admission_invalid`). Every member is grounded in a `block()` call in
 * `lib/a2a/bounded-exchange.js` or a refusal in
 * `lib/a2a/exchange-route-handler.js`. Building a record for any other type
 * throws, so an unknown failure can never be recorded as a known one.
 *
 * Retry safety is not re-decided here either: `classifyExchangeErrorType`
 * reuses `classifyEvaluatorReason`, so the acceptance property — an unknown
 * error type never enters the retry allowlist — falls out of the same
 * fail-closed default the retry module already pins.
 */

const crypto = require('node:crypto');

const { MAX_STRING_BYTES } = require('./bounded-exchange-contract');
const { RETRYABLE_EVALUATOR_REASONS, classifyEvaluatorReason } = require('./retry-classification');

const ERROR_SCHEMA_VERSION = 'v5-a2a-exchange-error-v1';
const TRACEBACK_MAX_BYTES = 8192;
const ERROR_RECORD_KEYS = Object.freeze([
  'schemaVersion', 'error_type', 'error_message', 'traceback_hash',
]);

// Terminal exchange codes beyond the pre-reservation evaluator reasons. Each
// is a string the exchange actually returns: `replay_detected` when the
// reservation already stood, `verification_failed` for the evaluator
// catch-all and handler fallback, `admission_invalid` for a malformed host
// admission decision. All three are unsafe to retry.
const TERMINAL_ERROR_TYPES = Object.freeze([
  'replay_detected',
  'verification_failed',
  'admission_invalid',
]);

const EXCHANGE_ERROR_TYPES = Object.freeze([
  ...RETRYABLE_EVALUATOR_REASONS,
  ...TERMINAL_ERROR_TYPES,
]);

function isErrorType(value) {
  return typeof value === 'string' && EXCHANGE_ERROR_TYPES.includes(value);
}

const TRACEBACK_HASH = /^[0-9a-f]{64}$/;

function boundedMessage(value) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES;
}

/**
 * Build the typed error record for an exchange refusal.
 *
 * `traceback` is optional and never stored: when present it must be a
 * bounded string and only its sha256 enters the record; when absent the
 * hash is null. Unknown types, empty or oversized messages, and oversized
 * tracebacks throw before anything is built.
 */
function buildExchangeErrorRecord({ errorType, errorMessage, traceback = null } = {}) {
  if (!isErrorType(errorType)) throw new Error('exchange_error_type_unknown');
  if (!boundedMessage(errorMessage)) throw new Error('exchange_error_message_invalid');
  let tracebackHash = null;
  if (traceback !== null && traceback !== undefined) {
    if (typeof traceback !== 'string' || traceback.length === 0
        || Buffer.byteLength(traceback, 'utf8') > TRACEBACK_MAX_BYTES) {
      throw new Error('exchange_error_traceback_invalid');
    }
    tracebackHash = crypto.createHash('sha256').update(traceback, 'utf8').digest('hex');
  }
  return Object.freeze({
    schemaVersion: ERROR_SCHEMA_VERSION,
    error_type: errorType,
    error_message: errorMessage,
    traceback_hash: tracebackHash,
  });
}

/**
 * Whether an error type is safe to retry. Reuses the evaluator allowlist, so
 * an unknown type — including a future code added without thought — is
 * unsafe by default.
 */
function classifyExchangeErrorType(errorType) {
  return classifyEvaluatorReason(errorType);
}

/**
 * Whether a record describes a retryable failure. Forged shapes, version
 * mismatches, malformed values (a missing message, a traceback hash that is
 * not a sha256 hex digest) and unknown types are unsafe rather than trusted.
 */
function isRetryableErrorRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || Reflect.ownKeys(record).length !== ERROR_RECORD_KEYS.length
      || !ERROR_RECORD_KEYS.every((key) => Object.hasOwn(record, key))
      || record.schemaVersion !== ERROR_SCHEMA_VERSION
      || !boundedMessage(record.error_message)
      || (record.traceback_hash !== null
        && !(typeof record.traceback_hash === 'string' && TRACEBACK_HASH.test(record.traceback_hash)))) {
    return false;
  }
  return classifyExchangeErrorType(record.error_type);
}

module.exports = Object.freeze({
  ERROR_SCHEMA_VERSION,
  TRACEBACK_MAX_BYTES,
  EXCHANGE_ERROR_TYPES,
  TERMINAL_ERROR_TYPES,
  isErrorType,
  buildExchangeErrorRecord,
  classifyExchangeErrorType,
  isRetryableErrorRecord,
});
