'use strict';

// #2167: the C8 binding snapshot taken from a C7 result, and the value
// helpers it needs.

const { isPlainObject } = require('./is-plain-object');
const { DELIVERY_ID_PATTERN, ERROR_CODES, HASH_PATTERN, SHA_PATTERN, fail } = require('./github-app-streaming-trust-contract');

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalInstantFromMs(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust clock is invalid');
  return new Date(nowMs).toISOString();
}

function snapshotC8Binding(c7Result) {
  const binding = c7Result && c7Result.binding;
  const receipt = c7Result && c7Result.receipt;
  if (!isPlainObject(binding)
      || !isPlainObject(receipt)
      || !DELIVERY_ID_PATTERN.test(binding.deliveryId)
      || !positiveSafeInteger(binding.repositoryId)
      || typeof binding.repositoryFullName !== 'string'
      || binding.repositoryFullName.length > 256
      || !/^[^/\s]+\/[^/\s]+$/.test(binding.repositoryFullName)
      || !positiveSafeInteger(binding.installationId)
      || !positiveSafeInteger(binding.pullRequestNumber)
      || typeof binding.headSha !== 'string' || !SHA_PATTERN.test(binding.headSha)
      || typeof receipt.receiptHash !== 'string' || !HASH_PATTERN.test(receipt.receiptHash)) {
    fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust requires a valid C7 delivery result');
  }
  return Object.freeze({
    deliveryId: binding.deliveryId.toLowerCase(),
    repositoryId: binding.repositoryId,
    repositoryFullName: binding.repositoryFullName,
    installationId: binding.installationId,
    pullRequestNumber: binding.pullRequestNumber,
    headSha: binding.headSha,
    c7ReceiptHash: receipt.receiptHash,
  });
}

module.exports = {
  canonicalInstantFromMs,
  positiveSafeInteger,
  snapshotC8Binding,
};
