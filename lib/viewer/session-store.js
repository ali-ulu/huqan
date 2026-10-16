'use strict';

const { randomBytes: nodeRandomBytes } = require('node:crypto');

const SESSION_ID_BYTES = 32;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function positiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function createSessionStore(options = {}) {
  const idleTtlMs = positiveInteger(options.idleTtlMs, 15 * 60_000, 'idleTtlMs');
  const absoluteTtlMs = positiveInteger(options.absoluteTtlMs, 8 * 60 * 60_000, 'absoluteTtlMs');
  const maxSessions = positiveInteger(options.maxSessions, 8, 'maxSessions');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomBytes = typeof options.randomBytes === 'function'
    ? options.randomBytes
    : nodeRandomBytes;
  const sessions = new Map();

  function create(opts = {}) {
    const workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim()
      ? opts.workspaceId.trim()
      : 'default';
    sweep();
    if (sessions.size >= maxSessions) {
      let oldestId;
      let oldestSeenAt = Infinity;
      for (const [sessionId, record] of sessions) {
        if (record.lastSeenAt < oldestSeenAt) {
          oldestId = sessionId;
          oldestSeenAt = record.lastSeenAt;
        }
      }
      if (oldestId !== undefined) sessions.delete(oldestId);
    }

    let sessionId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bytes = randomBytes(SESSION_ID_BYTES);
      if (!Buffer.isBuffer(bytes) || bytes.length !== SESSION_ID_BYTES) {
        throw new Error('session random source must return 32 bytes');
      }
      const candidate = bytes.toString('base64url');
      if (!sessions.has(candidate)) {
        sessionId = candidate;
        break;
      }
    }
    if (!sessionId) throw new Error('unable to allocate a unique session id');

    const createdAt = now();
    sessions.set(sessionId, { createdAt, lastSeenAt: createdAt, workspaceId });
    return {
      sessionId,
      expiresAt: createdAt + absoluteTtlMs,
      maxAgeSeconds: Math.floor(absoluteTtlMs / 1_000),
      workspaceId,
    };
  }

  function validate(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, reason: 'missing' };
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return { ok: false, reason: 'unknown' };
    }

    // A 256-bit opaque token makes Map lookup timing impractical as an oracle.
    const record = sessions.get(sessionId);
    if (!record) return { ok: false, reason: 'unknown' };

    const timestamp = now();
    if (timestamp < record.createdAt || timestamp < record.lastSeenAt) {
      sessions.delete(sessionId);
      return { ok: false, reason: 'clock_skew' };
    }
    if (timestamp - record.createdAt >= absoluteTtlMs) {
      sessions.delete(sessionId);
      return { ok: false, reason: 'absolute_expired' };
    }
    if (timestamp - record.lastSeenAt >= idleTtlMs) {
      sessions.delete(sessionId);
      return { ok: false, reason: 'idle_expired' };
    }

    record.lastSeenAt = timestamp;
    return {
      ok: true,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      expiresAt: record.createdAt + absoluteTtlMs,
      workspaceId: record.workspaceId,
    };
  }

  function destroy(sessionId) {
    return typeof sessionId === 'string' && sessions.delete(sessionId);
  }

  function reset() {
    sessions.clear();
  }

  function sweep() {
    const timestamp = now();
    let removed = 0;
    for (const [sessionId, record] of sessions) {
      if (
        timestamp < record.createdAt
        || timestamp < record.lastSeenAt
        || timestamp - record.createdAt >= absoluteTtlMs
        || timestamp - record.lastSeenAt >= idleTtlMs
      ) {
        sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    create,
    validate,
    destroy,
    reset,
    sweep,
    size: () => sessions.size,
  };
}

module.exports = { createSessionStore };
