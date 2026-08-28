'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 5 * 60_000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPathFor(journalPath) {
  return `${journalPath}.lock`;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    let record = null;
    try { record = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
    return { record, ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Whether a held lock should be refused rather than waited on.
 *
 * Two independent grounds, because they answer the question with different
 * confidence:
 *
 *   - A parsed record naming a pid that no longer exists. Liveness is decided,
 *     not estimated, so waiting out LOCK_WAIT_MS only delays the same refusal
 *     and reports it as contention (LOCK_TIMEOUT) instead of a crash.
 *   - Age, for every case liveness cannot settle: a record we could not parse
 *     (a lock caught half-written between openSync and the pid write, whose
 *     owner is very much alive), or a pid whose number may since have been
 *     reused by an unrelated process. Only there does the clock decide.
 *
 * The verdict itself is unchanged -- the lock is preserved for investigation,
 * never silently stolen.
 */
function reclaimable(lock) {
  if (!lock) return false;
  const pid = lock.record?.pid;
  if (Number.isInteger(pid) && pid > 0) return !processAlive(pid);
  return lock.ageMs >= STALE_LOCK_MS;
}

/** Path-taking form of `reclaimable`, so the predicate is testable on its own. */
function isReclaimableLock(journalPath) {
  return reclaimable(readLock(lockPathFor(journalPath)));
}

function release(lockPath, token) {
  const lock = readLock(lockPath);
  if (!lock || lock.record?.token !== token) return;
  try { fs.unlinkSync(lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function withMutationJournalLock(journalPath, mutate) {
  const lockPath = lockPathFor(journalPath);
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let descriptor;
    let created = false;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      created = true;
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      break;
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (created) {
        try { fs.unlinkSync(lockPath); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
      }
      if (error?.code !== 'EEXIST') throw error;
      const lock = readLock(lockPath);
      if (reclaimable(lock)) {
        const stale = new Error('mutation journal lock is stale and owned by a dead process');
        stale.code = 'MUTATION_JOURNAL_STALE_LOCK';
        stale.journalPath = journalPath;
        throw stale;
      }
      if (Date.now() >= deadline) {
        const timeout = new Error(`mutation journal lock timed out after ${LOCK_WAIT_MS}ms`);
        timeout.code = 'MUTATION_JOURNAL_LOCK_TIMEOUT';
        timeout.journalPath = journalPath;
        throw timeout;
      }
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return mutate();
  } finally {
    release(lockPath, token);
  }
}

module.exports = { LOCK_WAIT_MS, STALE_LOCK_MS, isReclaimableLock, lockPathFor, withMutationJournalLock };
