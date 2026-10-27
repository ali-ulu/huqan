// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * The append-only file sink for the SIEM export (#4093, PR-B3).
 *
 * This is the default transport of the whole feature, and the reason the
 * default needs no network: the operator's existing forwarder (Splunk UF,
 * Elastic Agent, Azure Monitor Agent) watches a file, so HUQAN only has to
 * append to one and never has to speak a collector's protocol itself.
 *
 * Two properties this module owns:
 *
 * - **A line reaches disk before the caller is told it did.** The write is a
 *   single `writeSync` on a freshly opened descriptor, followed by `fsync`, so
 *   the export runner can advance its cursor on the strength of the return
 *   value. INV-B1 rests on the export never touching the guard; INV-B4 rests
 *   on this one returning only after the bytes are down.
 * - **Rotation never drops an event.** A rotation renames the active file to
 *   its own numbered generation rather than overwriting a single `.1`, so an
 *   append-only trail stays append-only across rotations. An unbounded number
 *   of generations is deliberate: deleting a rotated file is the forwarder's
 *   retention decision, not this module's, because a sink that silently
 *   discards the oldest events is a sink that silently loses evidence.
 *
 * No clock and no randomness: a generation is the next free integer for this
 * file, so two runs against one directory cannot collide the way a timestamp
 * could. Mode is `0o600`, the same as the receipt trail it mirrors.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SIEM_MAX_BYTES = 10 * 1024 * 1024;

const SIEM_SINK_ERRORS = Object.freeze({
  MULTILINE: 'SIEM_SINK_MULTILINE_LINE',
});

/**
 * The next free generation for `target`: `<target>.1`, `<target>.2`, and so
 * on. Numbered rather than timestamped so the name is a pure function of what
 * is already in the directory.
 */
function nextGeneration(target) {
  const directory = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  let highest = 0;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const generation = Number.parseInt(entry.slice(prefix.length), 10);
    if (Number.isInteger(generation) && generation > highest) highest = generation;
  }
  return `${target}.${highest + 1}`;
}

/**
 * Opens the log for append and makes sure it is owner-only.
 *
 * `openSync(path, 'a', 0o600)` sets the mode only when it creates the file:
 * a log that already exists keeps whatever mode it had, so a world-readable
 * log would go on collecting events nobody chose to share. Where the
 * filesystem has modes, the descriptor is corrected before anything is
 * written to it.
 */
function openLog(resolved) {
  const descriptor = fs.openSync(resolved, 'a', 0o600);
  if (process.platform !== 'win32') {
    try {
      if ((fs.fstatSync(descriptor).mode & 0o777) !== 0o600) fs.fchmodSync(descriptor, 0o600);
    } catch (_) { /* the append itself is what matters */ }
  }
  return descriptor;
}

/**
 * Writes the whole payload, or throws. A short write that is reported as a
 * success would let the export advance its cursor past an event that never
 * reached the disk.
 */
function writeAll(descriptor, payload) {
  const buffer = Buffer.from(payload, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    const count = fs.writeSync(descriptor, buffer, written, buffer.length - written);
    if (count <= 0) throw new Error('the SIEM log write made no progress');
    written += count;
  }
}

function createSiemFileSink({ path: target, maxBytes = DEFAULT_SIEM_MAX_BYTES } = {}) {
  if (!target) throw new Error('SIEM file sink requires a path');
  const resolved = path.resolve(target);
  const parsedLimit = Number(maxBytes);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_SIEM_MAX_BYTES;

  return Object.freeze({
    kind: 'file',
    path: resolved,
    maxBytes: limit,
    /**
     * Appends one line per entry. A line that already contains a newline is
     * refused: accepting it would put two events on one line and break the
     * one-event-per-line framing every consumer of this file relies on.
     */
    write(entries) {
      const lines = Array.isArray(entries) ? entries : [entries];
      for (const line of lines) {
        if (typeof line !== 'string' || line.includes('\n')) {
          const error = new Error('a SIEM sink entry must be one line of text');
          error.code = SIEM_SINK_ERRORS.MULTILINE;
          throw error;
        }
      }
      if (lines.length === 0) return { bytes: 0, rotated: false };

      fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });

      let descriptor = null;
      let bytes = 0;
      let rotated = false;
      try {
        for (const line of lines) {
          const payload = `${line}\n`;
          const payloadBytes = Buffer.byteLength(payload, 'utf8');
          if (descriptor === null) descriptor = openLog(resolved);
          // The size comes from the descriptor this write is about to use, not
          // from a separate stat of the path: the file could change between
          // the two, and a rotation decided on a stale size would put the
          // active file over the limit it was meant to stay under.
          const existing = fs.fstatSync(descriptor).size;
          // Rotate between entries, not once per batch: a first export of a
          // thousand events must not land as one oversized file, so the limit
          // is checked before every single line.
          if (existing > 0 && existing + payloadBytes > limit) {
            fs.closeSync(descriptor);
            descriptor = null;
            fs.renameSync(resolved, nextGeneration(resolved));
            rotated = true;
            descriptor = openLog(resolved);
          }
          writeAll(descriptor, payload);
          fs.fsyncSync(descriptor);
          bytes += payloadBytes;
        }
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
      }
      return { bytes, rotated };
    },
  });
}

module.exports = {
  DEFAULT_SIEM_MAX_BYTES,
  SIEM_SINK_ERRORS,
  createSiemFileSink,
};
