'use strict';

// The break-glass ledger (İP-2): a hash-chained, append-only store of window
// events (issue / consume / lift), read and re-verified on every access.
//
// This is split out of lib/break-glass.js so the storage mechanics -- the
// chain, the cross-process lock, the fail-closed reads -- sit apart from the
// window semantics that use them. The chain shape is the emergency stop's
// (computeEntryHash is imported from lib/emergency-stop-chain.js, so the hash
// has one definition); what differs is the direction of failure, and that lives
// in the caller: an unverifiable chain yields no window and refuses a write.

const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');
const { computeEntryHash } = require('./emergency-stop-chain');

const BREAK_GLASS_LEDGER_FILE = 'ledger.jsonl';
const BREAK_GLASS_ACTIONS = Object.freeze(['issue', 'consume', 'lift']);
// One writer at a time across processes. `stale` bounds a crashed holder; a
// short bounded wait lets a concurrent hook finish rather than fail, and past
// the deadline the caller refuses (fail-closed) instead of waiting forever.
const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 500;
const LOCK_RETRY_MS = 25;

/** Block the process for `ms`. `proper-lockfile`'s sync API has no retry loop. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ledgerPath(root) {
  return path.join(root, BREAK_GLASS_LEDGER_FILE);
}

/** A hash-chained ledger over one directory. */
function createBreakGlassLedger(root) {
  function readEntries() {
    let raw;
    try {
      raw = fs.readFileSync(ledgerPath(root), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      return [{ __unreadable: true }];
    }
    if (!raw.trim()) return [];
    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const isPlainObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        entries.push(isPlainObject ? parsed : { __corrupt: true });
      } catch (_) {
        entries.push({ __corrupt: true });
      }
    }
    return entries;
  }

  function verifyEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { ok: true };
    for (const entry of entries) {
      if (entry.__unreadable || entry.__corrupt) return { ok: false, reason: 'ledger_unreadable_or_corrupt' };
    }
    let prevHash = null;
    // A window is issued once. `issue()` already refuses a duplicate id, but
    // that check does not run for an entry appended by anything else, and a
    // second `issue` would let the replay treat it as a re-issue -- replacing
    // `expiresAt`, `maxUses` and `categories` and resetting `uses`, widening or
    // extending an open window. Reject the shape `issue()` cannot produce, so a
    // chain that grants more than it was issued fails closed.
    const issuedWindows = new Set();
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (typeof entry.seq !== 'number' || entry.seq !== i) return { ok: false, reason: 'ledger_seq_gap', index: i };
      if ((entry.prevHash ?? null) !== prevHash) return { ok: false, reason: 'ledger_prevhash_mismatch', index: i };
      const { hash, seq, prevHash: storedPrev, ...payload } = entry;
      if (hash !== computeEntryHash(payload, prevHash)) return { ok: false, reason: 'ledger_hash_mismatch', index: i };
      if (!BREAK_GLASS_ACTIONS.includes(entry.action)) return { ok: false, reason: 'ledger_invalid_action', index: i };
      if (entry.action === 'issue') {
        if (issuedWindows.has(entry.windowId)) return { ok: false, reason: 'ledger_duplicate_issue', index: i };
        issuedWindows.add(entry.windowId);
      }
      prevHash = hash;
    }
    return { ok: true };
  }

  function verifyIntegrity() {
    return verifyEntries(readEntries());
  }

  /**
   * Run `operation` with the ledger directory locked, so a read-verify-append
   * sequence cannot interleave with another process (the hook runs as a
   * separate process per tool call). The lock is a directory `proper-lockfile`
   * creates next to the ledger; a crashed holder is reclaimed after
   * `LOCK_STALE_MS`. Returns `{ locked: false }` instead of throwing, so each
   * caller can fail closed with its own refusal reason.
   */
  function withLock(operation) {
    fs.mkdirSync(root, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    let release;
    for (;;) {
      try {
        release = lockfile.lockSync(root, { realpath: false, stale: LOCK_STALE_MS });
        break;
      } catch (error) {
        // ELOCKED is contention: wait briefly and retry. Anything else (a bad
        // path, an unreadable parent) is not going to clear, so give up now.
        if (error && error.code === 'ELOCKED' && Date.now() < deadline) {
          sleepSync(LOCK_RETRY_MS);
          continue;
        }
        return { locked: false };
      }
    }
    try {
      return { locked: true, value: operation() };
    } finally {
      try { release(); } catch (_) { /* a failed unlock leaves the stale lock to time out */ }
    }
  }

  function appendEntryUnlocked(payload) {
    const entries = readEntries();
    const verified = verifyEntries(entries);
    if (!verified.ok) throw new Error(`refusing to append to an unverifiable break-glass ledger: ${verified.reason}`);
    let prevHash = null;
    let seq = 0;
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      prevHash = last.hash;
      seq = entries.length;
    }
    const entry = { seq, prevHash, hash: computeEntryHash(payload, prevHash), ...payload };
    fs.appendFileSync(ledgerPath(root), `${JSON.stringify(entry)}\n`, 'utf8');
    return Object.freeze(entry);
  }

  function appendEntry(payload) {
    const result = withLock(() => appendEntryUnlocked(payload));
    if (!result.locked) throw new Error('refusing to append: the break-glass ledger is locked by another writer');
    return result.value;
  }

  return { readEntries, verifyEntries, verifyIntegrity, withLock, appendEntryUnlocked, appendEntry };
}

module.exports = {
  BREAK_GLASS_LEDGER_FILE,
  BREAK_GLASS_ACTIONS,
  ledgerPath,
  createBreakGlassLedger,
};
