'use strict';

/**
 * The SIEM export runner (#4093, PR-B3).
 *
 * One run: read the receipt trail the guard already wrote, render every
 * admission receipt the previous run has not exported yet into the canonical
 * `huqan.siem-event.v1`, hand the rendered lines to a sink, and move the
 * cursor. Nothing else. In particular it never evaluates a gate, never writes
 * to the receipt trail, and never imports the guard -- a sink that is down,
 * slow or wrong cannot reach a decision, because this runs as its own command
 * long after the decision was made (INV-B1).
 *
 * It reuses the collector's cursor semantics rather than inventing a second
 * one: the count into the append-only trail plus the id of the receipt it
 * stopped at, with the same resync when the trail was rotated or truncated
 * (lib/external-action-receipt-cursor.js). The two consumers keep separate
 * cursor files, so shipping to a collector and exporting to a SIEM are
 * independent -- neither can advance the other's position.
 *
 * At-least-once, not exactly-once: the cursor advances only after the sink
 * returned, so a crash in between re-exports the same events. That is the
 * deliberate direction of the trade, and it is why every event carries a
 * stable `event.id` (the receipt id) for a collector to dedupe on (INV-B4).
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  defaultExternalActionReceiptPath,
  defaultExternalActionStateRoot,
} = require('../external-action-receipt');
const { parseExternalActionReceiptLines } = require('../external-action-identity-log');
const { readCursor, writeCursor, unsentReceipts } = require('../external-action-receipt-cursor');
const { SIEM_ERRORS, receiptToSiemEvent } = require('./siem-event');
const { SIEM_FORMATS, SIEM_FORMATTER_ERRORS, formatSiemEvent } = require('./formatters');
const { createSiemFileSink } = require('./siem-file-sink');

// A receipt this runner cannot render is a receipt of another kind (an outcome,
// a review, an approval), which the trail legitimately holds. It is counted and
// stepped over: the mapper refuses to guess, and the export must not turn a
// correct refusal into a broken run.
const UNRENDERABLE_RECEIPT_CODES = new Set([
  SIEM_ERRORS.UNSUPPORTED_RECEIPT_KIND,
  SIEM_ERRORS.INVALID_RECEIPT,
]);

/** The pull target the default (file) transport writes: `HUQAN_STATE/siem/`. */
function defaultSiemLogPath(environment = process.env) {
  return path.join(defaultExternalActionStateRoot(environment), 'siem', 'huqan-events.jsonl');
}

function defaultSiemCursorPath(siemLogPath) {
  return `${siemLogPath}.cursor.json`;
}

function unsupportedFormat(format) {
  const error = new Error(`unsupported SIEM format: ${String(format)}`);
  error.code = SIEM_FORMATTER_ERRORS.UNSUPPORTED_FORMAT;
  return error;
}

/**
 * Renders what the cursor has not exported yet.
 *
 * `options.sink` is any object exposing `kind` and `write(lines)`; the default
 * is the append-only file sink, which is also the only transport that touches
 * no network. A caller that supplies its own sink (the syslog and HTTP
 * transports of PR-B4) replaces the transport without touching this loop.
 */
async function exportReceiptsToSiem(options = {}) {
  const environment = options.environment || process.env;
  const receiptPath = path.resolve(options.path || defaultExternalActionReceiptPath(environment));
  const siemLog = path.resolve(options.siemPath || defaultSiemLogPath(environment));
  const cursorPath = path.resolve(options.cursorPath || defaultSiemCursorPath(siemLog));
  const format = options.format || 'jsonl';
  const dryRun = Boolean(options.dryRun);
  const sink = options.sink || createSiemFileSink({ path: siemLog, maxBytes: options.maxBytes });

  // Refuse a format nobody implements before reading anything, so a
  // misconfigured run writes no half-file and no cursor it cannot defend.
  if (!SIEM_FORMATS.includes(format)) throw unsupportedFormat(format);

  let raw = '';
  try {
    raw = fs.readFileSync(receiptPath, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const { receipts, skipped } = parseExternalActionReceiptLines(raw);
  const cursor = readCursor(cursorPath);
  const { pending, resynced } = unsentReceipts(receipts, cursor);

  const report = {
    trail: receiptPath,
    siemLog,
    cursorPath,
    sink: { kind: sink.kind || 'custom', path: sink.path || '' },
    format,
    dryRun,
    scanned: receipts.length,
    skippedLines: skipped,
    pending: pending.length,
    resynced,
    exported: 0,
    rotations: 0,
    skippedReceipts: 0,
    failure: null,
  };
  if (dryRun || pending.length === 0) return Object.freeze(report);

  const lines = [];
  for (const receipt of pending) {
    try {
      lines.push(formatSiemEvent(receiptToSiemEvent(receipt), format));
    } catch (error) {
      if (error && UNRENDERABLE_RECEIPT_CODES.has(error.code)) {
        report.skippedReceipts += 1;
        continue;
      }
      throw error;
    }
  }

  try {
    const written = await sink.write(lines);
    if (written && written.rotated) report.rotations += 1;
  } catch (error) {
    // Nothing advances. The events stay pending, so the next run re-exports
    // them rather than losing them, and the guard's own trail is untouched.
    report.failure = { message: String((error && error.message) || error) };
    return Object.freeze(report);
  }

  const last = receipts[receipts.length - 1];
  writeCursor(cursorPath, {
    shipped: receipts.length,
    lastReceiptId: String((last && last.receiptId) || ''),
    lastCreatedAt: String((last && last.createdAt) || cursor.lastCreatedAt || ''),
  });
  report.exported = lines.length;
  return Object.freeze(report);
}

module.exports = {
  defaultSiemCursorPath,
  defaultSiemLogPath,
  exportReceiptsToSiem,
};
