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
 *
 * The mechanism itself is generic (`lib/hash-chain.js`); this module fixes the
 * receipt chain's genesis marker and its public vocabulary on top of it. The
 * marker stays distinct from every other chain's, so a link from one chain
 * cannot validate in another's position.
 */

const {
  CHAIN_INVALID_REASONS,
  appendToChain,
  validateChain,
} = require('../hash-chain');

// Explicit genesis marker for the first receipt in a workspace/chain, so a
// missing predecessor is never confused with an empty string or null.
const GENESIS_PREVIOUS_HASH = 'genesis:v4-receipt-chain';

/**
 * Append a new canonical receipt payload to a chain, producing a frozen,
 * hash-linked record. Does not mutate the input payload.
 */
function appendReceiptToChain(canonicalPayload, previousReceiptHash) {
  if (!canonicalPayload || typeof canonicalPayload !== 'object') {
    throw new TypeError('appendReceiptToChain requires a canonical receipt payload');
  }
  return appendToChain(canonicalPayload, previousReceiptHash || GENESIS_PREVIOUS_HASH);
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
  return validateChain(chainedReceipts, {
    genesisPreviousHash: opts.genesisPreviousHash || GENESIS_PREVIOUS_HASH,
  });
}

module.exports = {
  GENESIS_PREVIOUS_HASH,
  CHAIN_INVALID_REASONS,
  appendReceiptToChain,
  validateReceiptChain,
};
