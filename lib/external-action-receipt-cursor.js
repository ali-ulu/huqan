'use strict';

/**
 * External-action receipt cursor (#2252 split of lib/external-action-receipt-shipper.js).
 *
 * A cursor is a count into an append-only file plus the identity of the
 * receipt it claims to have stopped at. The count alone stops being
 * meaningful the moment the file is rotated or truncated, so the receipt is
 * checked on every read; nothing here knows about batches, collectors or
 * signing.
 */

const fs = require('node:fs');
const path = require('node:path');

function defaultCursorPath(receiptPath) {
  return `${receiptPath}.shipped.json`;
}

function readCursor(target) {
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    return {
      shipped: Number.isInteger(value.shipped) && value.shipped >= 0 ? value.shipped : 0,
      lastReceiptId: typeof value.lastReceiptId === 'string' ? value.lastReceiptId : '',
      lastCreatedAt: typeof value.lastCreatedAt === 'string' ? value.lastCreatedAt : '',
    };
  } catch (_) {
    return { shipped: 0, lastReceiptId: '', lastCreatedAt: '' };
  }
}

function writeCursor(target, cursor) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify({ ...cursor, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * A cursor is a count into an append-only file, which stops being meaningful
 * the moment the file is rotated or truncated. So the receipt it claims to
 * have stopped at is checked; when it does not match, the count is discarded
 * and everything newer than the last shipped timestamp is sent instead. The
 * report says this happened -- a silent resync would look exactly like a
 * collector quietly receiving duplicates.
 */
function unsentReceipts(receipts, cursor) {
  const at = receipts[cursor.shipped - 1];
  if (cursor.shipped > 0 && (!at || at.receiptId !== cursor.lastReceiptId)) {
    const after = cursor.lastCreatedAt;
    return { pending: receipts.filter(receipt => !after || String(receipt.createdAt) > after), resynced: true };
  }
  return { pending: receipts.slice(cursor.shipped), resynced: false };
}

module.exports = Object.freeze({
  defaultCursorPath,
  readCursor,
  writeCursor,
  unsentReceipts,
});
