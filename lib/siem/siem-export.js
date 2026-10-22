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

const crypto = require('node:crypto');
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

const SIEM_EXPORT_ERRORS = Object.freeze({
  PATH_COLLISION: 'SIEM_PATH_COLLISION',
  UNJUDGED_PUSH_SINK: 'SIEM_UNJUDGED_PUSH_SINK',
});

const PUSH_SINK_KINDS = new Set(['http', 'syslog']);

/**
 * The path with every symlink in it resolved.
 *
 * `path.resolve` does not dereference a symlink, so a cursor that is a link
 * to the receipt trail would pass a plain string comparison and then
 * truncate the trail with a cursor document. The path that does not exist
 * yet is canonicalized through its nearest existing ancestor, because the
 * log and the cursor are usually created by this very run.
 */
function canonicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  try {
    return path.join(fs.realpathSync(parent), base);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return resolved;
  }
}

/**
 * The export reads the receipt trail and must never write to it. An operator
 * who points the log or the cursor at the trail would otherwise append SIEM
 * events to the guard's own evidence, or replace it with a cursor document --
 * and a symlink would do the same without the operator ever naming the
 * trail. The paths are compared as they resolve on disk, and refused before
 * anything is read or written.
 */
function assertDistinctPaths(receiptPath, logPath, cursorPath) {
  const paths = [['receipt trail', receiptPath], ['SIEM log', logPath], ['cursor', cursorPath]]
    .filter(entry => entry[1])
    .map(entry => [entry[0], canonicalPath(entry[1])]);
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      if (paths[i][1] === paths[j][1]) {
        const error = new Error(`the SIEM ${paths[i][0]} and the ${paths[j][0]} must not be the same file: ${paths[i][1]}`);
        error.code = SIEM_EXPORT_ERRORS.PATH_COLLISION;
        throw error;
      }
    }
  }
}

/** The pull target the default (file) transport writes: `HUQAN_STATE/siem/`. */
function defaultSiemLogPath(environment = process.env) {
  return path.join(defaultExternalActionStateRoot(environment), 'siem', 'huqan-events.jsonl');
}

function defaultSiemCursorPath(siemLogPath) {
  return `${siemLogPath}.cursor.json`;
}

/**
 * A push destination's own cursor, one per endpoint and format, so exporting to
 * the local file and pushing to a collector -- or to two indexes, ports or
 * formats on one host -- never share a position and none can mark another's
 * events as delivered. The host stays readable in the name; the full endpoint
 * and format are folded into a short digest beside it.
 */
function defaultSiemPushCursorPath(sink, format, environment = process.env) {
  const host = String((sink && sink.host) || 'unknown').toLowerCase().replace(/[^a-z0-9.-]+/g, '_');
  const digest = crypto.createHash('sha256').update(`${sink && sink.kind}|${sink && sink.path}|${format}`).digest('hex').slice(0, 16);
  return path.join(defaultExternalActionStateRoot(environment), 'siem', `push-${sink && sink.kind}-${host}-${digest}.cursor.json`);
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
  const sink = options.sink || createSiemFileSink({
    path: path.resolve(options.siemPath || defaultSiemLogPath(environment)),
    maxBytes: options.maxBytes,
  });
  const isFileSink = sink.kind === 'file';
  // A push sink is built by a factory that judges its host (INV-B6) and carries
  // the verdict; one without it was assembled around that check.
  if (PUSH_SINK_KINDS.has(sink.kind) && !(sink.policy && sink.policy.allowed === true)) {
    const error = new Error(`a ${sink.kind} SIEM sink must come from its factory, which judges the destination first`);
    error.code = SIEM_EXPORT_ERRORS.UNJUDGED_PUSH_SINK;
    throw error;
  }
  // A push sink has no local log; reporting the default file path would name a
  // file this run never touches.
  const siemLog = isFileSink ? path.resolve(sink.path) : '';
  const format = options.format || 'jsonl';
  const cursorPath = path.resolve(options.cursorPath || (isFileSink
    ? defaultSiemCursorPath(siemLog)
    : defaultSiemPushCursorPath(sink, format, environment)));
  const dryRun = Boolean(options.dryRun);

  // Refuse a format nobody implements before reading anything, so a
  // misconfigured run writes no half-file and no cursor it cannot defend.
  if (!SIEM_FORMATS.includes(format)) throw unsupportedFormat(format);

  // The log and the cursor must not be the guard's receipt trail, and must not
  // be each other. A push sink has no local log at all, so only the paths
  // that name a file are compared.
  assertDistinctPaths(receiptPath, isFileSink ? siemLog : null, cursorPath);

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
    // Which kinds were stepped over, and how many of each. A count alone
    // cannot answer "why did my review receipt not reach the SIEM?"; the
    // kind can. These are categories, not contents -- the trail already
    // holds the receipt itself.
    skippedReceiptKinds: {},
    failure: null,
  };
  // The pending receipts are classified before the dry run returns, so a
  // preview says which kinds will not reach the SIEM -- the same answer a
  // real run gives, which is the point of asking for a preview.
  // The events travel beside their rendered lines: a push sink needs the
  // decision for a syslog severity and the event.id for an Elastic document id,
  // and must not re-parse a rendered CEF line to find them.
  const lines = [];
  const events = [];
  for (const receipt of pending) {
    try {
      const event = receiptToSiemEvent(receipt);
      lines.push(formatSiemEvent(event, format));
      events.push(event);
    } catch (error) {
      if (error && UNRENDERABLE_RECEIPT_CODES.has(error.code)) {
        report.skippedReceipts += 1;
        const kind = String((receipt && receipt.receiptKind) || 'unknown');
        report.skippedReceiptKinds[kind] = (report.skippedReceiptKinds[kind] || 0) + 1;
        continue;
      }
      throw error;
    }
  }
  if (dryRun || pending.length === 0) return Object.freeze(report);

  try {
    const written = await sink.write(lines, events);
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
  SIEM_EXPORT_ERRORS,
  defaultSiemCursorPath,
  defaultSiemLogPath,
  defaultSiemPushCursorPath,
  exportReceiptsToSiem,
};
