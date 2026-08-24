const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePathWithinRoot } = require('./path-safety');
const { normalizeWorkspaceId } = require('./workspace-id');

function toStableString(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(toStableString).join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ':' + toStableString(val[k]));
  }
  return '{' + parts.join(',') + '}';
}

// ISO-8601 calendar forms this codebase actually produces or accepts: a date,
// optionally followed by a time and an offset. Anything else -- '2024', '0',
// '12345', 'Mon Jan 01 2024' -- is not an ISO-8601 timestamp, however willing
// `new Date` is to parse it.
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Whether a string is a well-formed ISO-8601 date or timestamp.
 *
 * `new Date(str)` alone was not this check: it is lenient enough to accept
 * '2024', '0' and '12345', so a query guard built on it let a broken filter
 * through and then used the epoch-adjacent instant it parsed to as a real
 * query boundary. The shape is matched first, then the calendar date is
 * confirmed to exist, so '2024-13-99' and '2025-02-30' are rejected too.
 *
 * @param {*} str
 * @returns {boolean}
 */
function isValidIsoDate(str) {
  if (typeof str !== 'string') return false;
  const candidate = str.trim();
  const match = ISO_DATE_PATTERN.exec(candidate);
  if (!match) return false;

  const [, year, month, day, hour, minute, second] = match;
  const monthIndex = Number(month) - 1;
  const dayOfMonth = Number(day);
  const probe = new Date(Date.UTC(Number(year), monthIndex, dayOfMonth));
  // Date.UTC rolls overflow forward (month 12 -> next January), so a round-trip
  // is what separates a real calendar date from an arithmetically valid one.
  if (probe.getUTCFullYear() !== Number(year)
      || probe.getUTCMonth() !== monthIndex
      || probe.getUTCDate() !== dayOfMonth) return false;

  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return false;
  if (second !== undefined && Number(second) > 59) return false;

  return !Number.isNaN(Date.parse(candidate));
}

function makeProvenance(actor, workspaceId, trustPolicyVersion) {
  const now = new Date().toISOString();
  return {
    provenanceId: generateEventId(),
    sourceRef: 'axiom-memory-core',
    sourceTitle: 'AXIOM Memory Core',
    sourceType: 'memory-api',
    actor: actor || 'system',
    timestamp: now,
    workspaceId: normalizeWorkspaceId(workspaceId),
    trustPolicyVersion: trustPolicyVersion || '1.0.0',
    confidence: 1.0,
  };
}

function generateEventId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function getContentHash(content) {
  const payload = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * A sibling persistence path derived from a memory path.
 *
 * `base.replace(/\.json$/, suffix)` is a no-op when the base has no `.json`
 * extension, so an extensionless memoryPath collapsed the database, the JSON
 * memory file and the embedding dictionary onto one path. SQLite opened and
 * overwrote the file the JSON memory belonged in, save() then wrote JSON over
 * that database, and the embedding dictionary over that — every save
 * destroying the previous writer's data, with no warning anywhere. memoryPath
 * is user-supplied (HUQAN_MEMORY_PATH, CLI --memory-path, new Kernel({...}))
 * and the `.json` extension is nowhere required or validated (#1025).
 *
 * Appending when there is no extension to replace is what `_jsonJournalPath()`
 * and `resolveDbPath()` already did; this is that rule in one place, for every
 * derivation.
 */
function siblingPersistencePath(base, suffix) {
  const text = String(base || '');
  return /\.json$/i.test(text) ? text.replace(/\.json$/i, suffix) : `${text}${suffix}`;
}

/**
 * Refuses a persistence layout where two roles resolve to the same file.
 *
 * Comparison is on the resolved absolute path, because './mem.json' and
 * 'mem.json' name one file while differing as strings.
 *
 * @param {Record<string, string>} paths role name -> path
 * @throws {Error} when two roles name the same file
 */
function assertDistinctPersistencePaths(paths = {}) {
  const seen = new Map();
  for (const [role, value] of Object.entries(paths)) {
    if (typeof value !== 'string' || !value) continue;
    const resolved = path.resolve(value);
    const previous = seen.get(resolved);
    if (previous) {
      throw new Error(
        `Persistence paths collide: ${previous} and ${role} both resolve to ${resolved}. `
        + 'Each would overwrite the other on save; give them distinct paths '
        + '(a memoryPath ending in .json derives the rest automatically).',
      );
    }
    seen.set(resolved, role);
  }
}

/**
 * The full set of sibling paths a memoryPath implies, validated.
 *
 * Deriving each role separately is how they drifted apart: `_jsonJournalPath()`
 * guarded against a missing extension and the database and embedding
 * derivations did not. One function owns the layout so a new role cannot be
 * added to only some of the paths, and it refuses a layout in which two roles
 * name the same file — which is what an explicit colliding dbPath still does.
 *
 * @param {string} memoryPath
 * @param {string} [explicitDbPath] overrides the derived database path
 * @returns {{dbPath: string, embeddingPath: string, journalPath: string}}
 * @throws {Error} when two roles resolve to the same file
 */
function derivePersistenceLayout(memoryPath, explicitDbPath) {
  const layout = {
    dbPath: explicitDbPath || siblingPersistencePath(memoryPath, '.db'),
    embeddingPath: siblingPersistencePath(memoryPath, '.embeddings.json'),
    journalPath: siblingPersistencePath(memoryPath, '.mutations.json'),
  };
  assertDistinctPersistencePaths({ memoryPath, ...layout });
  return layout;
}

function resolveDbPath(opts = {}) {
  const roots = [
    process.cwd(),
    os.tmpdir(),
  ];
  if (typeof opts.rootDir === 'string' && opts.rootDir.trim()) {
    roots.push(opts.rootDir.trim());
  }
  if (typeof opts.memoryPath === 'string' && opts.memoryPath.trim()) {
    roots.push(path.dirname(path.resolve(opts.memoryPath.trim())));
  }

  const candidate = opts.dbPath
    ? opts.dbPath
    : (typeof opts.memoryPath === 'string' && opts.memoryPath.trim() && opts.memoryPath.trim().endsWith('.json'))
      ? opts.memoryPath.trim().replace(/\.json$/, '.db')
      : path.join(process.cwd(), 'memory.db');

  return resolveContainedPath(candidate, roots);
}

function isWithinRoot(candidate, root) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveContainedPath(candidate, allowedRoots = []) {
  const normalizedCandidate = path.resolve(candidate);
  const roots = allowedRoots
    .filter((root) => typeof root === 'string' && root.trim())
    .map((root) => path.resolve(root.trim()))
    .filter((root) => isWithinRoot(normalizedCandidate, root))
    .sort((left, right) => right.length - left.length);
  if (!roots.length) {
    const error = new Error('Path escapes allowed persistence roots');
    error.code = 'PATH_OUTSIDE_ALLOWED_ROOT'; error.path = normalizedCandidate;
    throw error;
  }
  return resolvePathWithinRoot(roots[0], normalizedCandidate, { allowMissing: true });
}

function generateMemoryId(content, workspaceId, createdAt) {
  const payload = JSON.stringify({ content, workspaceId, createdAt });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function generateLinkId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function generateDeterministicLinkId(workspaceId, fromMemoryId, toMemoryId, relation) {
  const payload = JSON.stringify({ workspaceId, fromMemoryId, toMemoryId, relation });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// PR-S3B: Bounded SQLite busy/locked retry with exponential backoff (sync).
// Keeps _withTransaction synchronous (no Promise / setTimeout).
const DEFAULT_BUSY_RETRY = Object.freeze({
  busyTimeoutMs: 250,
  maxAttempts: 3,
  initialBackoffMs: 5,
  backoffMultiplier: 2,
  maxBackoffMs: 40,
});

function resolveBusyRetryConfig(opts = {}) {
  const cfg = Object.assign({}, DEFAULT_BUSY_RETRY, opts || {});
  if (!Number.isInteger(cfg.maxAttempts) || cfg.maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(cfg.initialBackoffMs) || cfg.initialBackoffMs < 0) {
    throw new Error('initialBackoffMs must be a non-negative number');
  }
  if (!Number.isFinite(cfg.backoffMultiplier) || cfg.backoffMultiplier < 1) {
    throw new Error('backoffMultiplier must be >= 1');
  }
  if (!Number.isFinite(cfg.maxBackoffMs) || cfg.maxBackoffMs < cfg.initialBackoffMs) {
    throw new Error('maxBackoffMs must be >= initialBackoffMs');
  }
  if (!Number.isFinite(cfg.busyTimeoutMs) || cfg.busyTimeoutMs < 0) {
    throw new Error('busyTimeoutMs must be a non-negative number');
  }
  return cfg;
}

function isSqliteBusyError(err) {
  if (!err) return false;
  const code = err.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return msg.includes('SQLITE_BUSY')
    || msg.includes('SQLITE_LOCKED')
    || msg.includes('database is locked');
}

// Sync sleep using Atomics.wait on a SharedArrayBuffer.
// Bounded (caller caps it via maxBackoffMs) and only blocks the current thread.
function syncSleep(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function runWithBusyRetry(fn, opts = {}) {
  const cfg = resolveBusyRetryConfig(opts);
  const sleep = typeof opts.sleepFn === 'function' ? opts.sleepFn : syncSleep;
  const label = typeof opts.label === 'string' ? opts.label : 'runWithBusyRetry';
  let lastErr = null;
  let backoff = cfg.initialBackoffMs;
  let attempt = 0;
  for (attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusyError(err) || attempt === cfg.maxAttempts) {
        break;
      }
      sleep(backoff);
      backoff = Math.min(Math.floor(backoff * cfg.backoffMultiplier), cfg.maxBackoffMs);
    }
  }
  if (lastErr && isSqliteBusyError(lastErr)) {
    try { lastErr.busyRetries = attempt; } catch (_) { /* read-only property guard */ }
    try { lastErr.busyLabel = label; } catch (_) { /* read-only property guard */ }
  }
  throw lastErr;
}

module.exports = {
  toStableString,
  isValidIsoDate,
  makeProvenance,
  getContentHash,
  resolveDbPath,
  siblingPersistencePath,
  assertDistinctPersistencePaths,
  derivePersistenceLayout,
  resolveContainedPath,
  generateMemoryId,
  generateLinkId,
  generateDeterministicLinkId,
  generateEventId,
  normalizeWorkspaceId,
  // PR-S3B
  DEFAULT_BUSY_RETRY,
  resolveBusyRetryConfig,
  isSqliteBusyError,
  runWithBusyRetry,
  syncSleep,
};
