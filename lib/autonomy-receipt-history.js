'use strict';

// Receipt history reading for graduated autonomy (#2214).
//
// Single responsibility: load the bounded receipt trail and recognise the
// receipts autonomy reasons about -- identity scope, canonical hash validity,
// admission vs outcome kinds. No scoring, no tier policy, no transitions, no
// orchestration. Those stay in lib/graduated-autonomy.js, which re-exports
// hasValidReceiptHash and readReceiptHistory so existing importers keep
// working. This module is never a second authority for trust decisions.

const fs = require('node:fs');
const path = require('node:path');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');
const { hashCanonicalReceiptPayload } = require('./receipt/canonical-receipt');

const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_RECEIPTS = 10_000;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function identityRefFor(receipt) {
  return text(receipt?.metadata?.identity?.identityRef);
}

function belongsToIdentity(receipt, identityRef) {
  return identityRefFor(receipt) === identityRef;
}

function hasValidReceiptHash(receipt) {
  const supplied = text(receipt?.receiptHash).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  try {
    const payload = { ...receipt };
    delete payload.receiptHash;
    return hashCanonicalReceiptPayload(payload) === supplied;
  } catch (_) {
    return false;
  }
}

function isAdmissionReceipt(receipt) {
  return [
    'external_action_admission_receipt',
    'external_action_review_receipt',
    'external_action_rejection_receipt',
  ].includes(receipt?.receiptKind);
}

function isOutcomeReceipt(receipt) {
  return receipt?.receiptKind === 'external_action_outcome_receipt';
}

// Marks whether older receipts were left out, as a non-enumerable property so
// the array still compares and serializes as before. A cumulative reading needs
// to know when the window does not reach back to a session's start (#2505).
function marked(receipts, truncated) {
  Object.defineProperty(receipts, 'truncated', { value: truncated });
  return receipts;
}

function readReceiptHistory(options = {}) {
  if (Array.isArray(options.receipts)) {
    return marked(options.receipts.slice(-MAX_HISTORY_RECEIPTS), options.receipts.length > MAX_HISTORY_RECEIPTS);
  }
  const environment = options.environment || process.env;
  const target = path.resolve(options.path || defaultExternalActionReceiptPath(environment));
  // Open first, then measure the open descriptor: checking the path and opening
  // it afterwards leaves a window in which the file can be swapped. A missing
  // trail is an empty history.
  let fd;
  try {
    fd = fs.openSync(target, 'r');
  } catch (error) {
    if (error && error.code === 'ENOENT') return marked([], false);
    throw error;
  }
  let start;
  let buffer;
  try {
    const { size } = fs.fstatSync(fd);
    start = Math.max(0, size - MAX_HISTORY_BYTES);
    buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let raw = buffer.toString('utf8');
  if (start > 0) raw = raw.slice(Math.max(0, raw.indexOf('\n') + 1));
  const receipts = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) receipts.push(parsed);
    } catch (_) {
      // A damaged line cannot contribute positive evidence. Other valid,
      // hash-bearing receipts remain usable and the skipped line is never
      // interpreted as success.
    }
  }
  return marked(receipts.slice(-MAX_HISTORY_RECEIPTS), start > 0 || receipts.length > MAX_HISTORY_RECEIPTS);
}

module.exports = {
  MAX_HISTORY_BYTES,
  MAX_HISTORY_RECEIPTS,
  identityRefFor,
  belongsToIdentity,
  hasValidReceiptHash,
  isAdmissionReceipt,
  isOutcomeReceipt,
  readReceiptHistory,
};
