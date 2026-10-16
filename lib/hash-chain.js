'use strict';

/**
 * R36 (#3491) — generic hash-chain primitives.
 *
 * A tamper-evident chain over canonical payloads: each link commits to its own
 * content AND the hash of its predecessor, so mutating any record's content
 * changes its own recomputed hash and breaks the link the next record already
 * committed to. The tamper cannot be hidden by patching only the mutated record.
 *
 * Two chains in the system need this exact mechanism: the durable Trust receipt
 * chain (`lib/receipt/receipt-chain.js`) and the run checkpoint lineage
 * (`lib/storage/checkpoint-lineage.js`). It lives here, in the domain (Core),
 * rather than in either consumer, for two reasons:
 *
 *   - The persistence layer may not require the receipt layer just to chain its
 *     own rows (docs/architecture-policy.md §3). Chaining is not receipt-specific.
 *   - The genesis marker is a parameter, not a constant. A receipt chain and a
 *     checkpoint chain must not share a marker, or a checkpoint could be spliced
 *     into a receipt chain's position and validate.
 *
 * This module owns the canonical JSON + digest so there is one serialization and
 * one hash algorithm rather than a copy per chain. `lib/receipt/canonical-receipt.js`
 * re-exports `stableStringify`/`sha256Hex` from here so its existing consumers do
 * not move.
 */

const crypto = require('node:crypto');

const CHAIN_INVALID_REASONS = Object.freeze({
  GENESIS_MISMATCH: 'genesis_mismatch',
  CONTENT_TAMPERED: 'content_tampered',
  CHAIN_LINK_BROKEN: 'chain_link_broken',
});

/**
 * Deterministic JSON serialization: object keys are sorted recursively so the
 * same logical payload always serializes to the exact same string, regardless
 * of property insertion order. Arrays preserve their original order (order is
 * semantically meaningful for arrays, not for object keys).
 */
function stableStringify(value) {
  return JSON.stringify(sortForStableStringify(value, new WeakSet()));
}

// `seen` tracks objects/arrays on the current recursion path (not every object
// visited overall), so the same object referenced from two different branches --
// a DAG, which is fine -- is not mistaken for a cycle. Only an object that
// contains itself, directly or transitively, trips this and throws instead of
// recursing forever (#446).
function sortForStableStringify(value, seen) {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('stableStringify: circular reference detected');
    }
    seen.add(value);
    const result = value.map(item => sortForStableStringify(item, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      throw new TypeError('stableStringify: circular reference detected');
    }
    seen.add(value);
    // A null-prototype map keeps special own keys such as `__proto__` in the
    // canonical data instead of treating assignment as a prototype mutation.
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortForStableStringify(value[key], seen);
    }
    seen.delete(value);
    return sorted;
  }
  return value;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hash a canonical payload (deterministic: same payload -> same hash, always). */
function hashCanonicalPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('hashCanonicalPayload requires a canonical payload');
  }
  return sha256Hex(stableStringify(payload));
}

/**
 * Append a new canonical payload to a chain, producing a frozen, hash-linked
 * record. Does not mutate the input payload. `previousHash` is required: the
 * caller supplies the predecessor's hash, or its own explicit genesis marker for
 * the first link.
 */
function appendToChain(canonicalPayload, previousHash, { requirePreviousHash = true } = {}) {
  if (!canonicalPayload || typeof canonicalPayload !== 'object') {
    throw new TypeError('appendToChain requires a canonical payload');
  }
  if (requirePreviousHash && !previousHash) {
    throw new TypeError('appendToChain requires a previousHash (or an explicit genesis marker)');
  }
  const hashableRecord = { ...canonicalPayload, previousReceiptHash: previousHash };
  const receiptHash = hashCanonicalPayload(hashableRecord);
  return Object.freeze({ ...hashableRecord, receiptHash });
}

/**
 * Validate a sequence of chained records (as produced by appendToChain).
 * Returns `{ valid, brokenAt, reason }` — never throws for a tampered or
 * incomplete chain; throws only for a structurally malformed input (not an
 * array). `genesisPreviousHash` is the marker the first link must carry.
 */
function validateChain(chainedRecords, { genesisPreviousHash } = {}) {
  if (!Array.isArray(chainedRecords)) {
    throw new TypeError('validateChain requires an array of chained records');
  }

  for (let i = 0; i < chainedRecords.length; i++) {
    const record = chainedRecords[i];
    if (!record || typeof record !== 'object' || !record.receiptHash || !record.previousReceiptHash) {
      return { valid: false, brokenAt: i, reason: CHAIN_INVALID_REASONS.CONTENT_TAMPERED };
    }

    // 1. Self-consistency: does the stored hash match a fresh recompute of this
    //    record's own content (including its previousReceiptHash)?
    const { receiptHash: storedHash, ...withoutHash } = record;
    const recomputed = hashCanonicalPayload(withoutHash);
    if (recomputed !== storedHash) {
      return { valid: false, brokenAt: i, reason: CHAIN_INVALID_REASONS.CONTENT_TAMPERED };
    }

    // 2. Chain linkage: does this record's previousReceiptHash match the actual
    //    predecessor's hash (or the genesis marker for index 0)?
    if (i === 0) {
      if (record.previousReceiptHash !== genesisPreviousHash) {
        return { valid: false, brokenAt: i, reason: CHAIN_INVALID_REASONS.GENESIS_MISMATCH };
      }
    } else if (record.previousReceiptHash !== chainedRecords[i - 1].receiptHash) {
      return { valid: false, brokenAt: i, reason: CHAIN_INVALID_REASONS.CHAIN_LINK_BROKEN };
    }
  }

  return { valid: true, brokenAt: null, reason: null };
}

module.exports = {
  CHAIN_INVALID_REASONS,
  stableStringify,
  sha256Hex,
  hashCanonicalPayload,
  appendToChain,
  validateChain,
};
