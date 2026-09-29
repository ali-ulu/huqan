'use strict';

/**
 * Which command a reviewed admission was, kept beside the receipt trail rather
 * than inside it (#3025).
 *
 * Receipts hold a digest of the arguments and never the command itself -- not
 * even `git status` -- and they travel: the collector and fleet views ship them
 * off the machine. That property is deliberate and stays. But a digest cannot
 * say "npm test", so the approvals a person gives at review were a corpus
 * nobody could learn a command allowlist from.
 *
 * This log is the local half: one line per admission that went to review,
 * naming the command's leading words (see `commandShape` in
 * external-action-envelope) and the category the classifier gave it, keyed by
 * the admission id so lib/command-allowlist-miner.js can join it to the human
 * verdict in the trail. It is never collected and never part of a receipt
 * hash, which bounds what it can be trusted for: it feeds a proposal a person
 * reads, and nothing it says reaches a decision.
 *
 * Only reviews are recorded. An action the gate decided on its own carries no
 * human judgement, so logging its command would be keeping text for nothing.
 */

const path = require('node:path');
const { commandShape, EXTERNAL_ACTION_KINDS } = require('./external-action-envelope');
const { createJsonlExternalActionReceiptWriter, persistExternalActionReceipt } = require('./external-action-receipt');

const COMMAND_SHAPE_LOG_FILE = 'external-action-command-shapes.jsonl';

/** The log that annotates the receipt trail at `receiptPath`. */
function commandShapeLogPathFor(receiptPath) {
  return path.join(path.dirname(path.resolve(receiptPath)), COMMAND_SHAPE_LOG_FILE);
}

function createCommandShapeWriter(receiptPath) {
  return createJsonlExternalActionReceiptWriter({ path: commandShapeLogPathFor(receiptPath) });
}

/** The line to log for this admission, or null when there is nothing to learn from. */
function commandShapeEntry(envelope, receipt) {
  if (!receipt || receipt.decision !== 'review') return null;
  if (!envelope || envelope.kind !== EXTERNAL_ACTION_KINDS.SHELL) return null;
  const shape = commandShape(envelope.command);
  if (!shape) return null;
  return {
    admissionId: receipt.admissionId,
    workspaceId: receipt.workspaceId,
    shape,
    riskCategory: String(envelope.riskCategory || ''),
    recordedAt: receipt.createdAt,
  };
}

/**
 * Append the entry, if any. Returns the error message on failure rather than
 * throwing: the log feeds advice, so failing to write it must not turn a
 * review into a block -- but the caller surfaces it, so a log that has stopped
 * recording is visible rather than silently empty.
 */
function recordCommandShape(writer, envelope, receipt) {
  if (!writer) return null;
  const entry = commandShapeEntry(envelope, receipt);
  if (!entry) return null;
  try {
    persistExternalActionReceipt(writer, entry);
    return null;
  } catch (error) {
    return String(error?.message || error);
  }
}

module.exports = {
  COMMAND_SHAPE_LOG_FILE,
  commandShapeLogPathFor,
  createCommandShapeWriter,
  commandShapeEntry,
  recordCommandShape,
};
