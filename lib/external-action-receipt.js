const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultStateRoot } = require('./huqan-state-root');
const { buildDurableReceiptWriter } = require('./external-action-receipt-writer-factory');
const {
  EXTERNAL_ACTION_GUARD_VERSION,
  digest,
  safeBrowserDestination,
  MAX_DESTINATION_BYTES,
  buildExternalActionAdmissionReceipt,
} = require('./external-action-receipt-admission');
const {
  EFFECT_VERIFICATION,
  OUTCOME_REVIEW_DECISIONS,
  buildExternalActionOutcomeReceipt,
  buildExternalActionOutcomeReviewReceipt,
  receiptHashVerifies,
} = require('./external-action-receipt-outcome');

const MAX_RECEIPT_LINE_BYTES = 64 * 1024;


const OUTCOME_REVIEW_TAIL_BYTES = 4 * 1024 * 1024;

// Read only a bounded recent window of the JSONL trail, the same discipline
// the browser outcome hook applies to its admission lookup. A trail that does
// not exist yet holds no reviews -- that is a true answer, not an error;
// anything else that keeps the file from being read still throws.
function externalActionReceiptLines(receiptPath) {
  let fd;
  try {
    fd = fs.openSync(receiptPath, 'r');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - OUTCOME_REVIEW_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, OUTCOME_REVIEW_TAIL_BYTES));
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, count).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.filter(line => line.trim()).map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } finally { fs.closeSync(fd); }
}

/**
 * The newest review attached to an outcome, or null when none exists or none
 * verifies. "Newest" means the last matching line in the trail: appends are
 * the chain's order, and a review is recorded when it was made, so file order
 * is the honest answer even when two reviews share a timestamp. A line that
 * fails its own hash is skipped -- corruption is not the latest review.
 */
function latestExternalActionReview(receiptPath, outcomeReceiptId) {
  const target = typeof outcomeReceiptId === 'string' ? outcomeReceiptId.trim() : '';
  if (!target) throw new TypeError('latestExternalActionReview requires the outcome receipt id');
  let latest = null;
  for (const receipt of externalActionReceiptLines(receiptPath)) {
    if (receipt.receiptKind !== 'external_action_outcome_review_receipt') continue;
    if (receipt.metadata?.outcomeReceiptId !== target) continue;
    if (!receiptHashVerifies(receipt)) continue;
    latest = receipt;
  }
  return latest;
}

/**
 * The directory the gate keeps its own state in: the receipt trail and, beside
 * it, the command policy. Everything the guard persists or reads for itself
 * hangs off this one directory, so redirecting it moves the whole of the gate's
 * state -- which is what a test run needs, so that a suite can never observe or
 * extend the operator's real policy and receipt chain (#1846).
 *
 * `HUQAN_EXTERNAL_GUARD_RECEIPTS` still names a single file and wins over this,
 * because a deployment that placed its trail somewhere specific should keep it.
 *
 * The resolution itself now lives in lib/huqan-state-root.js: this module
 * reaches `../graph`, so anything downward of graph.js that needed the state
 * root closed a require cycle. Kept as a named export because callers and
 * tests already use it under this name.
 */
function defaultExternalActionStateRoot(environment = process.env) {
  return defaultStateRoot(environment);
}

function defaultExternalActionReceiptPath(environment = process.env) {
  const override = typeof environment.HUQAN_EXTERNAL_GUARD_RECEIPTS === 'string'
    ? environment.HUQAN_EXTERNAL_GUARD_RECEIPTS.trim()
    : '';
  if (override) return path.resolve(override);
  return path.join(defaultExternalActionStateRoot(environment), 'external-action-receipts.jsonl');
}

function createJsonlExternalActionReceiptWriter(options = {}) {
  const target = path.resolve(options.path || defaultExternalActionReceiptPath(options.environment));
  return Object.freeze({
    path: target,
    append(receipt) {
      const line = `${JSON.stringify(receipt)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_RECEIPT_LINE_BYTES) {
        throw new Error('external action receipt exceeds the 64 KiB persistence bound');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(target, 'a', 0o600);
      try {
        fs.writeSync(fd, line, null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return receipt;
    },
  });
}

function createDurableExternalActionReceiptWriter(options = {}) {
  // The JSONL trail is created first, then the graph the writer owns (#2192).
  const jsonlWriter = options.jsonlWriter || createJsonlExternalActionReceiptWriter(options);
  return buildDurableReceiptWriter({ ...options, jsonlWriter });
}

function persistExternalActionReceipt(writer, receipt) {
  if (!writer) return false;
  if (typeof writer === 'function') writer(receipt);
  else if (writer && typeof writer.append === 'function') writer.append(receipt);
  else throw new TypeError('receiptWriter must be a function or expose append(receipt)');
  return true;
}

module.exports = {
  EFFECT_VERIFICATION,
  EXTERNAL_ACTION_GUARD_VERSION,
  MAX_RECEIPT_LINE_BYTES,
  OUTCOME_REVIEW_DECISIONS,
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
  buildExternalActionOutcomeReviewReceipt,
  createDurableExternalActionReceiptWriter,
  createJsonlExternalActionReceiptWriter,
  defaultExternalActionReceiptPath,
  defaultExternalActionStateRoot,
  latestExternalActionReview,
  persistExternalActionReceipt,
  safeBrowserDestination,
  MAX_DESTINATION_BYTES,
  digestExternalActionValue: digest,
};
