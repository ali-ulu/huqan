'use strict';

// #2225: the Streaming Trust store. Its two support modules were split out
// by responsibility: store-records.js validates binding and writeback
// record shapes, store-files.js owns bounded exclusive JSON record IO. This
// file keeps the store state machine: directory layout, evaluation commits,
// writeback reserve/commit with their conflict rules.

const path = require('node:path');
const { hashCanonicalReceiptPayload } = require('./receipt/canonical-receipt');
const { isPlainObject } = require('./is-plain-object');
const {
  STORE_VERSION,
  DELIVERY_ID_PATTERN,
  HASH_PATTERN,
  ERROR_CODES,
  GitHubAppStreamingStoreError,
  fail,
  exactKeys,
  positiveSafeInteger,
  canonicalInstant,
  snapshotBinding,
  bindingIdentity,
  snapshotStartedRecord,
  snapshotCompleteRecord,
} = require('./github-app-streaming-trust-store-records');
const {
  assertRoot,
  ensureDirectory,
  writeExclusiveJson,
  readJsonFile,
} = require('./github-app-streaming-trust-store-files');

// Receipt checks stay here rather than in store-records.js: they need
// the canonical receipt hash, and that edge is already recorded on this
// file in the architecture baseline. Moving it would count as new debt.
function receiptHasValidHash(receipt) {
  if (!isPlainObject(receipt)
      || typeof receipt.receiptHash !== 'string'
      || !HASH_PATTERN.test(receipt.receiptHash)) return false;
  const { receiptHash, ...hashable } = receipt;
  try {
    return hashCanonicalReceiptPayload(hashable) === receiptHash;
  } catch (_) {
    return false;
  }
}

function receiptMatchesBinding(receipt, binding) {
  const metadata = receipt && receipt.metadata;
  return receiptHasValidHash(receipt)
    && receipt.previousReceiptHash === binding.c7ReceiptHash
    && isPlainObject(metadata)
    && metadata.deliveryId === binding.deliveryId
    && metadata.repositoryId === binding.repositoryId
    && metadata.repositoryFullName === binding.repositoryFullName
    && metadata.installationId === binding.installationId
    && metadata.pullRequestNumber === binding.pullRequestNumber
    && metadata.headSha === binding.headSha
    && metadata.c7ReceiptHash === binding.c7ReceiptHash;
}

function createGitHubAppStreamingTrustStore({ rootPath }) {
  const root = path.join(assertRoot(rootPath), 'streaming-trust');
  const evaluationsDir = path.join(root, 'evaluations');
  const startedDir = path.join(root, 'writeback-started');
  const completeDir = path.join(root, 'writeback-complete');
  for (const directory of [root, evaluationsDir, startedDir, completeDir]) ensureDirectory(directory);

  function fileFor(directory, deliveryId) {
    if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
      fail(ERROR_CODES.INVALID_BINDING, 'Streaming Trust delivery ID is invalid');
    }
    return path.join(directory, `${deliveryId.toLowerCase()}.json`);
  }

  function readEvaluation(deliveryId) {
    const record = readJsonFile(fileFor(evaluationsDir, deliveryId));
    if (!record) return null;
    const binding = snapshotBinding(record.binding);
    if (!exactKeys(record, ['schemaVersion', 'binding', 'receipt'])
        || record.schemaVersion !== STORE_VERSION
        || !receiptMatchesBinding(record.receipt, binding)) {
      fail(ERROR_CODES.INVALID_RECEIPT, 'Stored Streaming Trust evaluation is invalid');
    }
    return Object.freeze({ binding, receipt: record.receipt });
  }

  function commitEvaluation(inputBinding, receipt) {
    const binding = snapshotBinding(inputBinding);
    if (!receiptMatchesBinding(receipt, binding)) {
      fail(ERROR_CODES.INVALID_RECEIPT, 'Streaming Trust receipt does not match its binding');
    }
    const filePath = fileFor(evaluationsDir, binding.deliveryId);
    const created = writeExclusiveJson(filePath, { schemaVersion: STORE_VERSION, binding, receipt });
    if (created) return Object.freeze({ duplicate: false, binding, receipt });
    const existing = readEvaluation(binding.deliveryId);
    if (!existing
        || bindingIdentity(existing.binding) !== bindingIdentity(binding)
        || JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) {
      fail(ERROR_CODES.DELIVERY_CONFLICT, 'Streaming Trust delivery already has a different evaluation');
    }
    return Object.freeze({ duplicate: true, binding: existing.binding, receipt: existing.receipt });
  }

  function readWriteback(deliveryId) {
    const complete = readJsonFile(fileFor(completeDir, deliveryId));
    if (complete) return snapshotCompleteRecord(complete);
    const started = readJsonFile(fileFor(startedDir, deliveryId));
    if (started) return snapshotStartedRecord(started);
    return Object.freeze({ state: 'none' });
  }

  function reserveWriteback({ binding: inputBinding, receiptHash, externalId, startedAt }) {
    const binding = snapshotBinding(inputBinding);
    if (!HASH_PATTERN.test(receiptHash)
        || typeof externalId !== 'string' || externalId.length === 0 || externalId.length > 512
        || !canonicalInstant(startedAt)) {
      fail(ERROR_CODES.INVALID_BINDING, 'Streaming Trust writeback reservation is invalid');
    }
    const evaluation = readEvaluation(binding.deliveryId);
    if (!evaluation
        || bindingIdentity(evaluation.binding) !== bindingIdentity(binding)
        || evaluation.receipt.receiptHash !== receiptHash) {
      fail(ERROR_CODES.DELIVERY_CONFLICT, 'Streaming Trust writeback has no matching evaluation');
    }

    const existing = readWriteback(binding.deliveryId);
    if (existing.state === 'complete') return existing;
    if (existing.state === 'started') {
      if (bindingIdentity(existing.binding) !== bindingIdentity(binding)
          || existing.receiptHash !== receiptHash
          || existing.externalId !== externalId) {
        fail(ERROR_CODES.DELIVERY_CONFLICT, 'Streaming Trust writeback reservation conflicts with stored state');
      }
      return existing;
    }

    const record = { schemaVersion: STORE_VERSION, binding, receiptHash, externalId, startedAt };
    const created = writeExclusiveJson(fileFor(startedDir, binding.deliveryId), record);
    if (!created) return reserveWriteback({ binding, receiptHash, externalId, startedAt });
    return Object.freeze({ state: 'reserved', ...record });
  }

  function commitWriteback({ binding: inputBinding, receiptHash, externalId, checkRunId, completedAt }) {
    const binding = snapshotBinding(inputBinding);
    if (!HASH_PATTERN.test(receiptHash)
        || typeof externalId !== 'string' || externalId.length === 0 || externalId.length > 512
        || !positiveSafeInteger(checkRunId)
        || !canonicalInstant(completedAt)) {
      fail(ERROR_CODES.INVALID_BINDING, 'Streaming Trust writeback result is invalid');
    }
    const started = readWriteback(binding.deliveryId);
    if (started.state === 'complete') {
      if (bindingIdentity(started.binding) === bindingIdentity(binding)
          && started.receiptHash === receiptHash
          && started.externalId === externalId
          && started.checkRunId === checkRunId) return started;
      fail(ERROR_CODES.DELIVERY_CONFLICT, 'Streaming Trust writeback result conflicts with stored state');
    }
    if (started.state !== 'started'
        || bindingIdentity(started.binding) !== bindingIdentity(binding)
        || started.receiptHash !== receiptHash
        || started.externalId !== externalId) {
      fail(ERROR_CODES.WRITEBACK_STATE_UNKNOWN, 'Streaming Trust writeback state is unknown');
    }

    const record = {
      schemaVersion: STORE_VERSION,
      binding,
      receiptHash,
      externalId,
      checkRunId,
      startedAt: started.startedAt,
      completedAt,
    };
    const created = writeExclusiveJson(fileFor(completeDir, binding.deliveryId), record);
    if (!created) return commitWriteback({ binding, receiptHash, externalId, checkRunId, completedAt });
    return Object.freeze({ state: 'complete', ...record });
  }

  return Object.freeze({
    commitEvaluation,
    readEvaluation,
    reserveWriteback,
    readWriteback,
    commitWriteback,
  });
}

module.exports = {
  STORE_VERSION,
  ERROR_CODES,
  GitHubAppStreamingStoreError,
  createGitHubAppStreamingTrustStore,
};
