'use strict';

/**
 * HTTP projection of readReceiptById's failure statuses (#766).
 *
 * `chain_invalid` needs a code of its own: a receipt whose materialized chain
 * fails validation is not missing and its id is not malformed, so reporting it
 * as either would tell the viewer the wrong story -- and serving it as an
 * ordinary 200 would let the UI call a broken transcript canonical. 409 says
 * the resource exists but is in a state the caller must reckon with.
 */
const RECEIPT_READ_FAILURES = Object.freeze({
  not_found: Object.freeze({ statusCode: 404, code: 'receipt_not_found' }),
  invalid_request: Object.freeze({ statusCode: 400, code: 'invalid_receipt_id' }),
  invalid: Object.freeze({ statusCode: 400, code: 'invalid_receipt_id' }),
  chain_invalid: Object.freeze({ statusCode: 409, code: 'receipt_chain_invalid' }),
});

/**
 * Unknown statuses fall back to the malformed-request answer, never to 200.
 *
 * The lookup is by own property. `Object.freeze` seals the table's contents but
 * leaves its prototype chain intact, so a bare `TABLE[status]` answers
 * `'constructor'` and `'toString'` with inherited functions -- truthy, so the
 * `||` fallback never runs and the caller receives a value with no
 * `statusCode`. That is the one outcome this table exists to prevent (#1270).
 */
function receiptReadFailure(status) {
  return Object.hasOwn(RECEIPT_READ_FAILURES, status)
    ? RECEIPT_READ_FAILURES[status]
    : RECEIPT_READ_FAILURES.invalid_request;
}

module.exports = { RECEIPT_READ_FAILURES, receiptReadFailure };
