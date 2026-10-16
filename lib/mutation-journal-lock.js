'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const properLockfile = require('proper-lockfile');
const { atomicWriteFileSync } = require('./graph-record-utils');

const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 2_000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPathFor(journalPath) { return `${journalPath}.lock`; }
function ownerPathFor(journalPath) { return `${journalPath}.lock.owner.json`; }

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function readOwner(journalPath) {
  try { return JSON.parse(fs.readFileSync(ownerPathFor(journalPath), 'utf8')); }
  catch (_) { return null; }
}

function isReclaimableLock(journalPath) {
  let stat;
  try { stat = fs.statSync(lockPathFor(journalPath)); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory()) return false;
  const owner = readOwner(journalPath);
  if (Number.isInteger(owner?.pid) && owner.pid > 0) return !processAlive(owner.pid);
  return Date.now() - stat.mtimeMs >= STALE_LOCK_MS;
}

function lockFs(journalPath, state) {
  const lockPath = lockPathFor(journalPath);
  return {
    ...fs,
    statSync(target) {
      const stat = fs.statSync(target);
      // The synchronous graph API can occupy the event loop longer than the
      // mtime heartbeat interval. A contender must not steal that live lock.
      if (!state.owned && target === lockPath) {
        const owner = readOwner(journalPath);
        if (processAlive(owner?.pid)) {
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mtime: new Date() });
        }
      }
      return stat;
    },
  };
}

function removeOwner(journalPath, token) {
  const ownerPath = ownerPathFor(journalPath);
  const owner = readOwner(journalPath);
  if (owner?.token !== token) return;
  try { fs.unlinkSync(ownerPath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function withMutationJournalLock(journalPath, mutate) {
  const existing = (() => {
    try { return fs.statSync(lockPathFor(journalPath)); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  })();
  if (existing && !existing.isDirectory()) {
    const error = new Error('legacy mutation journal lock requires explicit recovery');
    error.code = 'MUTATION_JOURNAL_LOCK_FORMAT';
    error.journalPath = journalPath;
    throw error;
  }

  const state = { owned: false };
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  let release;
  for (;;) {
    try {
      release = properLockfile.lockSync(journalPath, {
        realpath: false,
        stale: STALE_LOCK_MS,
        update: 1_000,
        retries: 0,
        fs: lockFs(journalPath, state),
      });
      state.owned = true;
      atomicWriteFileSync(ownerPathFor(journalPath), JSON.stringify({
        pid: process.pid, token, acquiredAt: new Date().toISOString(),
      }));
      break;
    } catch (error) {
      if (error?.code !== 'ELOCKED') throw error;
      if (Date.now() >= deadline) {
        const timeout = new Error(`mutation journal lock timed out after ${LOCK_WAIT_MS}ms`);
        timeout.code = 'MUTATION_JOURNAL_LOCK_TIMEOUT';
        timeout.journalPath = journalPath;
        throw timeout;
      }
      sleep(LOCK_RETRY_MS);
    }
  }

  try { return mutate(); }
  finally {
    // Remove ownership evidence while the directory lock still excludes new
    // owners; deleting it after release could erase a successor's record.
    removeOwner(journalPath, token);
    release();
  }
}

module.exports = {
  LOCK_WAIT_MS, STALE_LOCK_MS, isReclaimableLock, lockPathFor, ownerPathFor,
  withMutationJournalLock,
};
