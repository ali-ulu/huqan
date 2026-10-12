'use strict';

// The approval authority's append-only ledger (#3860, ADR-016 item 8).
//
// One JSON line per event, each hash-linked to the one before it through
// lib/hash-chain.js, written with an fsync before the append returns. The
// ledger is the authority's source of truth: the service rebuilds its view of
// every approval from it at start, and `huqan audit --authority` checks local
// approvals and receipts against it.
//
// A ledger that does not validate -- an edited byte, a removed line, a torn
// final write -- is opened as corrupt. Reads still serve it, so an audit can see
// what is there, but nothing more is appended to a chain that can no longer be
// trusted to be whole. A failed append poisons the store the same way: part of
// the line may already be on disk, and chaining after it would only bury the
// damage. Recovery is an operator decision, not this module's.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const fs = require('node:fs');
const { appendToChain, validateChain } = require('../hash-chain');

const LEDGER_GENESIS = 'huqan.authority.ledger.v1';
const MAX_PAGE = 500;

function readLines(file) {
  if (!fs.existsSync(file)) return { records: [], corrupt: null };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      return { records, corrupt: { brokenAt: i, reason: 'unparseable_line' } };
    }
  }
  const check = validateChain(records, { genesisPreviousHash: LEDGER_GENESIS });
  if (!check.valid) return { records, corrupt: { brokenAt: check.brokenAt, reason: check.reason } };
  const misnumbered = records.findIndex((record, i) => record.seq !== i);
  return { records, corrupt: misnumbered >= 0 ? { brokenAt: misnumbered, reason: 'sequence_gap' } : null };
}

function appendDurably(file, line, io) {
  const bytes = Buffer.from(line, 'utf8');
  const fd = io.openSync(file, 'a', 0o600);
  try {
    let written = 0;
    while (written < bytes.length) written += io.writeSync(fd, bytes, written, bytes.length - written);
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

function openLedgerStore({ file, io = fs }) {
  const loaded = readLines(file);
  const records = loaded.records;
  let corrupt = loaded.corrupt;

  function head() {
    const last = records[records.length - 1];
    return last ? { seq: last.seq, hash: last.receiptHash } : { seq: -1, hash: LEDGER_GENESIS };
  }

  function append(type, body, at) {
    if (corrupt) throw new Error(`ledger is corrupt at entry ${corrupt.brokenAt} (${corrupt.reason}); refusing to append`);
    const { seq, hash } = head();
    const record = appendToChain({ seq: seq + 1, type, at, body }, hash);
    try {
      appendDurably(file, `${JSON.stringify(record)}\n`, io);
    } catch (error) {
      corrupt = { brokenAt: seq + 1, reason: 'append_failed' };
      throw error;
    }
    records.push(record);
    return record;
  }

  /** A bounded page, for callers outside the service. */
  function entries({ fromSeq = 0, limit = MAX_PAGE } = {}) {
    const start = Math.max(0, Number.isInteger(fromSeq) ? fromSeq : 0);
    const size = Math.min(MAX_PAGE, Math.max(1, Number.isInteger(limit) ? limit : MAX_PAGE));
    return records.slice(start, start + size);
  }

  /** Every entry, for the service's own rebuild at start. */
  function all() {
    return records.slice();
  }

  return { get corrupt() { return corrupt; }, head, append, entries, all };
}

module.exports = { LEDGER_GENESIS, MAX_PAGE, openLedgerStore };
