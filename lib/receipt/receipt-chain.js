'use strict';

/**
 * V4-PR2.5 — Trust Receipt Primitive Hardening: chain validation.
 *
 * A chained receipt's hash commits to BOTH its own canonical payload AND the
 * hash of its predecessor (`previousReceiptHash` is part of what gets
 * hashed, not just a sibling field). This is what makes the chain actually
 * tamper-evident: mutating any receipt's content changes its own
 * recomputed hash, which breaks the link the next receipt already committed
 * to — the tamper cannot be hidden by only patching the mutated receipt.
 */

const { hashCanonicalReceiptPayload } = require('./canonical-receipt');

// Explicit genesis marker for the first receipt in a workspace/chain, so a
// missing predecessor is never confused with an empty string or null.
const GENESIS_PREVIOUS_HASH = 'genesis:v4-receipt-chain';

const CHAIN_INVALID_REASONS = Object.freeze({
  GENESIS_MISMATCH: 'genesis_mismatch',
  CONTENT_TAMPERED: 'content_tampered',
  CHAIN_LINK_BROKEN: 'chain_link_broken',
});

/**
 * Append a new canonical receipt payload to a chain, producing a frozen,
 * hash-linked record. Does not mutate the input payload.
 */
function appendReceiptToChain(canonicalPayload, previousReceiptHash) {
  if (!canonicalPayload || typeof canonicalPayload !== 'object') {
    throw new TypeError('appendReceiptToChain requires a canonical receipt payload');
  }
  const prevHash = previousReceiptHash || GENESIS_PREVIOUS_HASH;
  const hashableRecord = { ...canonicalPayload, previousReceiptHash: prevHash };
  const receiptHash = hashCanonicalReceiptPayload(hashableRecord);
  return Object.freeze({ ...hashableRecord, receiptHash });
}

/**
 * Validate a sequence of chained receipts (as produced by
 * appendReceiptToChain). Returns { valid, brokenAt, reason } — never throws
 * for a tampered/invalid chain; throws only for a structurally malformed
 * input (not an array, empty record, etc.).
 */
function validateReceiptChain(chainedReceipts, opts = {}) {
  if (!Array.isArray(chainedReceipts)) {
    throw new TypeError('validateReceiptChain requires an array of chained receipts');
  }
  const genesisPreviousHash = opts.genesisPreviousHash || GENESIS_PREVIOUS_HASH;

  for (let i = 0; i < chainedReceipts.length; i++) {
    const record = chainedReceipts[i];
    if (!record || typeof record !== 'object' || !record.receiptHash || !record.previousReceiptHash) {
      return { valid: false, brokenAt: i, reason: CHAIN_INVALID_REASONS.CONTENT_TAMPERED };
    }

    // 1. Self-consistency: does the stored hash match a fresh recompute of
    //    this record's own content (including its previousReceiptHash)?
    const { receiptHash: storedHash, ...withoutHash } = record;
    const recomputed = hashCanonicalReceiptPayload(withoutHash);
    if (recomputed !== storedHash) {
      return { valid: false, brokenAt: i, reason: CHAIN_INVALID_REASONS.CONTENT_TAMPERED };
    }

    // 2. Chain linkage: does this record's previousReceiptHash match the
    //    actual predecessor's hash (or the genesis marker for index 0)?
    if (i === 0) {
      if (record.previousReceiptHash !== genesisPreviousHash) {
        return { valid: false, brokenAt: i, reason: CHAIN_INVALID_REASONS.GENESIS_MISMATCH };
      }
    } else if (record.previousReceiptHash !== chainedReceipts[i - 1].receiptHash) {
      return { valid: false, brokenAt: i, reason: CHAIN_INVALID_REASONS.CHAIN_LINK_BROKEN };
    }
  }

  return { valid: true, brokenAt: null, reason: null };
}

module.exports = {
  GENESIS_PREVIOUS_HASH,
  CHAIN_INVALID_REASONS,
  appendReceiptToChain,
  validateReceiptChain,
};
