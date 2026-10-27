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

// Receipts this module parsed and deep-froze, mapped to their hash validity
// once computed. One decision checks the same receipts from the trust score,
// the autonomy state and the session impact; only a receipt that cannot change
// after the check may reuse its result (#4325). Caller-supplied receipts are
// never entered here and are re-verified on every call.
const parsedReceipts = new WeakMap();

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function hasValidReceiptHash(receipt) {
  const known = parsedReceipts.get(receipt);
  if (known !== undefined) return known;
  const valid = recomputesReceiptHash(receipt);
  if (parsedReceipts.has(receipt)) parsedReceipts.set(receipt, valid);
  return valid;
}

function recomputesReceiptHash(receipt) {
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

// #4335: the receipt window autonomy scores over. N counts this identity's
// hash-valid receipts, so a tamper flood or another agent's traffic can never
// crowd valid history out of the window; the read stays inside the same
// MAX_HISTORY_BYTES / MAX_HISTORY_RECEIPTS bound as the full read.
function hasWindow(options) {
  return Number.isInteger(options.receiptWindow) && options.receiptWindow > 0 && Boolean(text(options.identityRef));
}

// This identity's receipts from the N-th newest hash-valid one onwards.
// Hash-invalid receipts inside that span stay in, so session impact still
// reports them as failed verification; they never consume a slot. `cut` is
// true when an older hash-valid receipt of this identity was left out.
function identityWindow(receipts, options) {
  const own = receipts.filter((receipt) => belongsToIdentity(receipt, options.identityRef));
  let from = own.length;
  let valid = 0;
  while (from > 0 && valid < options.receiptWindow) {
    from -= 1;
    if (hasValidReceiptHash(own[from])) valid += 1;
  }
  return { receipts: own.slice(from), valid, cut: own.slice(0, from).some(hasValidReceiptHash) };
}

// Reads the trail backwards from the end, doubling the chunk until the window
// holds N hash-valid receipts of this identity or the read reaches the file
// start or the byte bound. Parsing only the tail is what keeps a decision's
// cost bounded when the trail is long (#4335).
function readTrailWindow(fd, size, options) {
  // A line already parsed in a smaller chunk keeps its frozen receipt, so its
  // hash check is cached too; doubling does not repeat the parse or the hash.
  const seen = new Map();
  let chunk = Math.min(64 * 1024, MAX_HISTORY_BYTES);
  for (;;) {
    const start = Math.max(0, size - chunk);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let raw = buffer.toString('utf8');
    if (start > 0) raw = raw.slice(Math.max(0, raw.indexOf('\n') + 1));
    const parsed = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (seen.has(line)) {
        if (seen.get(line)) parsed.push(seen.get(line));
        continue;
      }
      seen.set(line, null);
      try {
        const receipt = JSON.parse(line);
        if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
          parsedReceipts.set(deepFreeze(receipt), undefined);
          seen.set(line, receipt);
          parsed.push(receipt);
        }
      } catch (_) {
        // A damaged line cannot contribute positive evidence. Other valid,
        // hash-bearing receipts remain usable and the skipped line is never
        // interpreted as success.
      }
    }
    const windowed = identityWindow(parsed, options);
    if (windowed.valid >= options.receiptWindow || start === 0 || chunk >= MAX_HISTORY_BYTES) {
      return marked(windowed.receipts, start > 0 || windowed.cut);
    }
    chunk = Math.min(chunk * 2, MAX_HISTORY_BYTES);
  }
}

function readReceiptHistory(options = {}) {
  if (Array.isArray(options.receipts)) {
    const receipts = options.receipts.slice(-MAX_HISTORY_RECEIPTS);
    const truncated = options.receipts.length > MAX_HISTORY_RECEIPTS;
    if (hasWindow(options)) {
      const windowed = identityWindow(receipts, options);
      return marked(windowed.receipts, windowed.cut || truncated);
    }
    return marked(receipts, truncated);
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
  let receipts;
  try {
    const { size } = fs.fstatSync(fd);
    if (hasWindow(options)) {
      receipts = readTrailWindow(fd, size, options);
    } else {
      const start = Math.max(0, size - MAX_HISTORY_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let raw = buffer.toString('utf8');
      if (start > 0) raw = raw.slice(Math.max(0, raw.indexOf('\n') + 1));
      const parsed = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const receipt = JSON.parse(line);
          if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
            parsedReceipts.set(deepFreeze(receipt), undefined);
            parsed.push(receipt);
          }
        } catch (_) {
          // A damaged line cannot contribute positive evidence. Other valid,
          // hash-bearing receipts remain usable and the skipped line is never
          // interpreted as success.
        }
      }
      receipts = marked(parsed, start > 0 || parsed.length > MAX_HISTORY_RECEIPTS);
    }
  } finally {
    fs.closeSync(fd);
  }
  return marked(receipts.slice(-MAX_HISTORY_RECEIPTS), receipts.truncated || receipts.length > MAX_HISTORY_RECEIPTS);
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
