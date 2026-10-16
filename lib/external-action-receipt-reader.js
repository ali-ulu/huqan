'use strict';

/**
 * Read the append-only external-action receipt trail.
 *
 * The shipper reads the same file, but reads it as a queue -- it tracks a
 * cursor, batches from it and marks progress. A reader that wants to reason
 * over the whole history needs the opposite: no cursor, no side effects, and a
 * tolerance for lines it does not understand.
 *
 * Tolerant on purpose. This is an append-only file written by whatever version
 * of the guard was running at the time, so it will contain shapes this build
 * has never seen and, after a hard kill, at most one truncated final line.
 * Refusing the whole trail because of one bad line would make the history
 * unusable for exactly the incident somebody is trying to reconstruct. Bad
 * lines are counted rather than thrown, so a caller can tell "the trail is
 * clean" from "the trail is mostly unreadable".
 */

const fs = require('node:fs');
const path = require('node:path');

const { defaultExternalActionReceiptPath } = require('./external-action-receipt');
const { isPlainObject } = require('./is-plain-object');

/**
 * @param {object} [options]
 * @param {string} [options.path] receipt log; defaults to the deployment's
 * @param {object} [options.environment]
 * @returns {object[]} every receipt the file holds, oldest first
 */
function readExternalActionReceipts(options = {}) {
  return readExternalActionReceiptsWithErrors(options).receipts;
}

/**
 * The same read, with the count of lines that could not be parsed.
 *
 * @returns {{receipts: object[], unreadableLines: number, receiptPath: string}}
 */
function readExternalActionReceiptsWithErrors(options = {}) {
  const receiptPath = path.resolve(
    options.path || defaultExternalActionReceiptPath(options.environment || process.env),
  );

  let raw;
  // A trail that does not exist yet is an empty history, not an error: a fresh
  // installation has simply not made a decision yet.
  try { raw = fs.readFileSync(receiptPath, 'utf8'); } catch (_) {
    return { receipts: [], unreadableLines: 0, receiptPath };
  }

  const receipts = [];
  let unreadableLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch (_) { unreadableLines += 1; continue; }
    if (isPlainObject(parsed)) receipts.push(parsed);
    else unreadableLines += 1;
  }
  return { receipts, unreadableLines, receiptPath };
}

module.exports = { readExternalActionReceipts, readExternalActionReceiptsWithErrors };
