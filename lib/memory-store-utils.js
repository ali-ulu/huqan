const crypto = require('crypto');
const path = require('path');

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

function isValidIsoDate(str) {
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
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

function normalizeWorkspaceId(value) {
  return String(value || 'default').trim() || 'default';
}

function getContentHash(content) {
  const payload = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function resolveDbPath(opts = {}) {
  if (opts.dbPath) return opts.dbPath;
  if (typeof opts.memoryPath === 'string' && opts.memoryPath.endsWith('.json')) {
    return opts.memoryPath.replace(/\.json$/, '.db');
  }
  return path.join(process.cwd(), 'memory.db');
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
