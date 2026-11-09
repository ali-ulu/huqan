'use strict';

const crypto = require('crypto');
const { normalizeWorkspaceId } = require('./workspace-id');
const { resolveDefaultMemoryPath } = require('./default-persistence-path');
const {
  resolveDbPath,
  siblingPersistencePath,
  assertDistinctPersistencePaths,
  derivePersistenceLayout,
  resolveContainedPath,
} = require('./memory-persistence-paths');
const {
  DEFAULT_BUSY_RETRY,
  resolveBusyRetryConfig,
  isSqliteBusyError,
  runWithBusyRetry,
  syncSleep,
} = require('./sqlite-busy-retry');

function toStableString(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(toStableString).join(',') + ']';
  const keys = Object.keys(val).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ':' + toStableString(val[k]));
  }
  return '{' + parts.join(',') + '}';
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isValidIsoDate(str) {
  if (typeof str !== 'string') return false;
  const candidate = str.trim();
  const match = ISO_DATE_PATTERN.exec(candidate);
  if (!match) return false;

  const [, year, month, day, hour, minute, second] = match;
  const monthIndex = Number(month) - 1;
  const dayOfMonth = Number(day);
  const probe = new Date(Date.UTC(Number(year), monthIndex, dayOfMonth));
  if (probe.getUTCFullYear() !== Number(year)
      || probe.getUTCMonth() !== monthIndex
      || probe.getUTCDate() !== dayOfMonth) return false;

  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return false;
  if (second !== undefined && Number(second) > 59) return false;

  return !Number.isNaN(Date.parse(candidate));
}

function generateEventId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
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

function getContentHash(content) {
  const payload = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(payload).digest('hex');
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

// #4559: the SQLite opt-in reaches MemoryStore as a caller/config value, not
// necessarily a boolean. Before this, `useSQLite !== true` meant a truthy
// `'1'`/`1` silently dropped to the ephemeral memory backend while the same
// value with no driver threw — one input, two outcomes. Normalize the accepted
// spellings of true/false here and reject the rest, so "ask for SQLite" always
// means the same thing. `undefined` stays `undefined` (the default backend).
const USE_SQLITE_TRUE = new Set([true, 1, '1', 'true']);
const USE_SQLITE_FALSE = new Set([false, 0, '0', 'false']);

function normalizeUseSQLiteFlag(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (USE_SQLITE_TRUE.has(token)) return true;
    if (USE_SQLITE_FALSE.has(token)) return false;
    throw invalidUseSQLite(value);
  }
  if (USE_SQLITE_TRUE.has(value)) return true;
  if (USE_SQLITE_FALSE.has(value)) return false;
  throw invalidUseSQLite(value);
}

function invalidUseSQLite(value) {
  const error = new TypeError(`invalid useSQLite value: ${JSON.stringify(value)}; expected a boolean, 0/1 or 'true'/'false'`);
  error.code = 'HUQAN_INVALID_USE_SQLITE';
  return error;
}

// Hook graph.close to also close the memory store db connection — once, so a
// second close (closeSqlite + graph.close) never relies on the store's own guard.
function hookGraphCloseForMemoryStore(kernel) {
  const originalClose = kernel.graph.close;
  let memoryClosed = false;
  kernel.graph.close = () => {
    if (typeof originalClose === 'function') {
      originalClose.call(kernel.graph);
    }
    if (!memoryClosed && kernel.memory && typeof kernel.memory.close === 'function') {
      memoryClosed = true;
      kernel.memory.close();
    }
  };
}

module.exports = {
  resolveDefaultMemoryPath,
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
  hookGraphCloseForMemoryStore,
  normalizeUseSQLiteFlag,
  normalizeWorkspaceId,
  DEFAULT_BUSY_RETRY,
  resolveBusyRetryConfig,
  isSqliteBusyError,
  runWithBusyRetry,
  syncSleep,
};
