'use strict';

/**
 * R36 (#3491) — Checkpoint lineage.
 *
 * A run checkpoint is resumable state on disk. Without a hash, editing
 * `state_json` by hand — or dropping a row — is invisible: the resume path
 * hydrates whatever the file says. This module gives checkpoint rows the same
 * tamper-evidence the durable receipt chain already has, by reusing that chain
 * primitive instead of inventing a second hashing scheme.
 *
 * `appendCheckpointToChain` hashes a checkpoint's canonical payload together
 * with the hash of its predecessor in the same goal+workspace chain, exactly as
 * `appendReceiptToChain` does for receipts. `validateCheckpointChain` walks a
 * set of chained checkpoints and reports the first break, so a broken or
 * incomplete chain fails closed rather than resuming from tampered state.
 *
 * ## What the hash covers
 *
 * The payload is the checkpoint's own identity and durable content: id, goal,
 * goal key, workspace, status, iteration, budget, last action and the two JSON
 * blobs (`state_json`, `evidence_json`). `created_at` and `updated_at` are
 * deliberately excluded: they are the storage clock, not the record's content,
 * so a re-save that only advances the clock must not read as a tamper.
 *
 * ## Legacy rows
 *
 * A checkpoint written before the hash columns existed carries no hash. Such a
 * row is `unstamped` and is neither accepted nor rejected here — the caller
 * decides, because a database that predates the column is not the same event as
 * a tampered one. A row that *has* a hash which does not match its content is
 * different: that is a tamper and fails closed.
 */

const {
  GENESIS_PREVIOUS_HASH,
  CHAIN_INVALID_REASONS,
  appendReceiptToChain,
  validateReceiptChain,
} = require('../receipt/receipt-chain');

/**
 * Raised when a hashed checkpoint row no longer matches its own content. It is
 * an Error rather than a `null` load so a tampered row is surfaced through the
 * existing storage-failure path (agent.v3.js / mcp-agent-continuation.js turn a
 * thrown load error into a fail-closed envelope) instead of being mistaken for
 * "no checkpoint to resume".
 */
class CheckpointIntegrityError extends Error {
  constructor({ checkpointId, brokenAt, reason }) {
    super(`Checkpoint ${checkpointId} failed integrity verification (${reason} at index ${brokenAt}).`);
    this.name = 'CheckpointIntegrityError';
    this.code = 'CHECKPOINT_INTEGRITY_VIOLATION';
    this.checkpointId = checkpointId;
    this.brokenAt = brokenAt;
    this.reason = reason;
  }
}

/** The checkpoint fields the lineage hash commits to. */
const CHECKPOINT_HASH_FIELDS = Object.freeze([
  'id',
  'goal_key',
  'goal',
  'workspace_id',
  'status',
  'iteration',
  'budget_remaining',
  'last_action',
  'state_json',
  'evidence_json',
]);

/**
 * Build the canonical, hashable payload for a checkpoint row. Every field is
 * coerced to a string so a value read back from SQLite (a number column) hashes
 * identically to the value written from JavaScript.
 */
function checkpointCanonicalPayload(row) {
  if (!row || typeof row !== 'object') {
    throw new TypeError('checkpointCanonicalPayload requires a checkpoint row');
  }
  const payload = {};
  for (const field of CHECKPOINT_HASH_FIELDS) {
    const value = row[field];
    payload[field] = value === undefined || value === null ? '' : String(value);
  }
  return payload;
}

/**
 * Append a checkpoint row to its chain, producing a frozen, hash-linked record
 * (the same shape `appendReceiptToChain` returns). Does not mutate the input.
 */
function appendCheckpointToChain(row, previousCheckpointHash) {
  return appendReceiptToChain(checkpointCanonicalPayload(row), previousCheckpointHash);
}

/**
 * Validate a sequence of chained checkpoint records. Returns
 * `{ valid, brokenAt, reason }` and never throws for a tampered or incomplete
 * chain; the reusable receipt-chain validator owns that logic.
 */
function validateCheckpointChain(records, opts = {}) {
  return validateReceiptChain(records, opts);
}

module.exports = {
  GENESIS_PREVIOUS_HASH,
  CHAIN_INVALID_REASONS,
  CHECKPOINT_HASH_FIELDS,
  CheckpointIntegrityError,
  checkpointCanonicalPayload,
  appendCheckpointToChain,
  validateCheckpointChain,
};
