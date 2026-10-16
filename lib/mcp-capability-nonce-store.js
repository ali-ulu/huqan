'use strict';

/**
 * Durable consumed-nonce store for MCP operator capabilities (#1674).
 *
 * A capability is single-use: verifyMcpOperatorCapability() records its nonce
 * and refuses the token if that nonce comes back. Recording it in a process-
 * local Map made "single-use" true only for as long as the process lived. A
 * capability is valid for up to five minutes (MAX_TTL_MS), and a restart
 * inside that window -- a crash, a redeploy, an operator-triggered reload, or
 * simply a second worker that never saw the first request -- wiped the
 * consumed set while the token itself was still perfectly valid. The same
 * approve-and-execute capability then worked a second time.
 *
 * The durable form is one small file per consumed nonce, created with the
 * exclusive `wx` flag. That flag is the whole mechanism: `open(O_CREAT|O_EXCL)`
 * is atomic on POSIX and on Windows, so exactly one caller can create the file
 * and every concurrent or later attempt gets EEXIST. No lock file, no
 * read-modify-write window between "is it consumed" and "mark it consumed" --
 * the two are a single syscall, which is what makes concurrent workers safe.
 *
 * The file name is a hash of the nonce rather than the nonce itself: nonces
 * are attacker-influenced strings that must not be able to escape the
 * directory or collide with a path the filesystem treats specially. Its
 * contents are the capability's expiry, so a sweep can drop records once the
 * capability they belong to could no longer be accepted anyway.
 *
 * Fail-closed: every error other than "already consumed" is reported as a
 * refusal. If the directory cannot be created or written, verification denies
 * the capability rather than falling back to accepting it -- an unavailable
 * durable store must not silently restore the replayable behaviour it exists
 * to remove.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');

/** Sweep at most this often; a sweep is a directory read plus a few unlinks. */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Grace period beyond a record's expiry before it is swept. Clocks between
 * concurrent workers are not identical, and deleting a record the moment it
 * expires on the fastest worker would let a slower one accept the same
 * capability again inside its own validity window.
 */
const SWEEP_GRACE_MS = 60_000;

function nonceFileName(nonce) {
  return `${crypto.createHash('sha256').update(String(nonce), 'utf8').digest('hex')}.nonce`;
}

/**
 * @param {object} options
 * @param {string} options.directory Directory that holds one file per consumed nonce.
 * @param {object} [options.fileSystem] Injectable fs, for tests.
 * @returns {{consume: (nonce: string, exp: number, now: number) => boolean, sweep: (now?: number) => number, directory: string}}
 */
function createDurableCapabilityNonceStore({ directory, fileSystem = fs } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new TypeError('durable capability nonce store requires a directory');
  }
  const resolved = path.resolve(directory);
  let lastSweep = 0;

  function sweep(now = Date.now()) {
    let removed = 0;
    let entries;
    try {
      entries = fileSystem.readdirSync(resolved);
    } catch (_) {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.nonce')) continue;
      const file = path.join(resolved, entry);
      let expSeconds;
      try {
        expSeconds = Number.parseInt(fileSystem.readFileSync(file, 'utf8').trim(), 10);
      } catch (_) {
        continue;
      }
      // An unreadable or malformed record is left alone rather than deleted:
      // deleting it would re-enable the replay it was written to prevent.
      if (!Number.isFinite(expSeconds)) continue;
      if (expSeconds * 1000 + SWEEP_GRACE_MS > Number(now)) continue;
      try {
        fileSystem.rmSync(file, { force: true });
        removed += 1;
      } catch (_) {
        // A concurrent sweep won the race; nothing to do.
      }
    }
    return removed;
  }

  function consume(nonce, exp, now = Date.now()) {
    if (typeof nonce !== 'string' || !nonce) return false;
    try {
      fileSystem.mkdirSync(resolved, { recursive: true });
    } catch (_) {
      return false;
    }

    if (Number(now) - lastSweep >= SWEEP_INTERVAL_MS) {
      lastSweep = Number(now);
      sweep(now);
    }

    const target = path.join(resolved, nonceFileName(nonce));
    const record = `${Number.isInteger(exp) ? exp : Math.floor(Number(now) / 1000)}\n`;
    try {
      // The reservation and the check are the same operation: EEXIST here is
      // the replay answer, and nothing between the two can interleave.
      fileSystem.writeFileSync(target, record, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      // EEXIST: already consumed. Anything else: the durable store is not
      // working, and a capability that cannot be recorded is not accepted.
      return false;
    }
  }

  return { consume, sweep, directory: resolved };
}

/**
 * Where consumed capability nonces are recorded (#1674).
 *
 * Defaults to a directory beside the memory store, so a deployment that
 * already persists memory to a mounted volume gets durable replay protection
 * with no extra configuration. HUQAN_MCP_CAPABILITY_NONCE_DIR overrides it for
 * deployments whose workers share a different writable path -- and sharing one
 * path across workers is the point: the store is what makes a capability
 * single-use across all of them, not merely within one.
 */
function resolveCapabilityNonceDirectory(options, envKernelOpts) {
  const configured = options.capabilityNonceDir
    || readCompatibleEnvironmentVariable('MCP_CAPABILITY_NONCE_DIR');
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim());
  const memoryPath = options.memoryPath || envKernelOpts.memoryPath || 'memory.json';
  return path.resolve(path.dirname(path.resolve(memoryPath)), '.huqan-capability-nonces');
}
module.exports = {
  SWEEP_GRACE_MS,
  SWEEP_INTERVAL_MS,
  createDurableCapabilityNonceStore,
  nonceFileName,
  resolveCapabilityNonceDirectory,
};
