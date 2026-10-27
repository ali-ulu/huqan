// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

// Dedicated OIDC session store (#4267; contract in docs/sso.md).
//
// Deliberately not the in-memory viewer store: that one keeps raw session
// identifiers in a Map, and the contract requires a durable store keyed by
// sha256(sessionId) only. The raw identifier lives in the browser cookie and
// nowhere else, so a database read cannot be turned into a session.
//
// better-sqlite3 with WAL and synchronous = FULL: a session that survives a
// crash is the point of a session, and the write volume is one row per login.
// `:memory:` is accepted so the route tests need no filesystem.
//
// Idle and absolute expiry are enforced on read, and revocation is a delete.

const crypto = require('node:crypto');

const SESSION_ID_BYTES = 32;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
// Hard upper bounds: a deployment may shorten these but never widen them past
// the contract's stated limits.
const MAX_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;

let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  Database = null;
}

function positiveInteger(value, fallback, maximum, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return resolved;
}

function hashSessionId(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId), 'utf8').digest('base64url');
}

function createOidcSessionStore(options = {}) {
  if (!Database) throw new Error('better-sqlite3 is required for the OIDC session store');
  const dbPath = typeof options.dbPath === 'string' && options.dbPath ? options.dbPath : ':memory:';
  const idleTtlMs = positiveInteger(options.idleTtlMs, DEFAULT_IDLE_TTL_MS, MAX_IDLE_TTL_MS, 'idleTtlMs');
  const absoluteTtlMs = positiveInteger(options.absoluteTtlMs, DEFAULT_ABSOLUTE_TTL_MS, MAX_ABSOLUTE_TTL_MS, 'absoluteTtlMs');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;

  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS oidc_sessions (
      session_hash TEXT NOT NULL PRIMARY KEY,
      operator_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) WITHOUT ROWID
  `);

  const insert = db.prepare(
    'INSERT INTO oidc_sessions (session_hash, operator_id, subject, role, csrf_token, created_at, last_seen_at, expires_at) '
    + 'VALUES (@sessionHash, @operatorId, @subject, @role, @csrfToken, @createdAt, @lastSeenAt, @expiresAt)',
  );
  const select = db.prepare('SELECT * FROM oidc_sessions WHERE session_hash = ?');
  const touch = db.prepare('UPDATE oidc_sessions SET last_seen_at = ? WHERE session_hash = ?');
  const remove = db.prepare('DELETE FROM oidc_sessions WHERE session_hash = ?');
  const sweepStatement = db.prepare('DELETE FROM oidc_sessions WHERE expires_at <= ?');

  function newSessionId() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bytes = randomBytes(SESSION_ID_BYTES);
      if (!Buffer.isBuffer(bytes) || bytes.length !== SESSION_ID_BYTES) {
        throw new Error('session random source must return 32 bytes');
      }
      const candidate = bytes.toString('base64url');
      if (!select.get(hashSessionId(candidate))) return candidate;
    }
    throw new Error('unable to allocate a unique session id');
  }

  function create({ principal } = {}) {
    if (!principal || typeof principal.operatorId !== 'string' || typeof principal.role !== 'string') {
      throw new TypeError('a principal with operatorId and role is required');
    }
    const createdAt = now();
    const sessionId = newSessionId();
    const csrfToken = randomBytes(32).toString('base64url');
    insert.run({
      sessionHash: hashSessionId(sessionId),
      operatorId: principal.operatorId,
      subject: String(principal.subject || ''),
      role: principal.role,
      csrfToken,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: createdAt + absoluteTtlMs,
    });
    return {
      sessionId,
      csrfToken,
      expiresAt: createdAt + absoluteTtlMs,
      maxAgeSeconds: Math.floor(absoluteTtlMs / 1000),
      operatorId: principal.operatorId,
      role: principal.role,
    };
  }

  function validate(sessionId, { csrfToken } = {}) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return { ok: false, reason: 'unknown' };
    }
    const row = select.get(hashSessionId(sessionId));
    if (!row) return { ok: false, reason: 'unknown' };
    const timestamp = now();
    if (timestamp >= row.expires_at) {
      remove.run(row.session_hash);
      return { ok: false, reason: 'absolute_expired' };
    }
    if (timestamp - row.last_seen_at >= idleTtlMs) {
      remove.run(row.session_hash);
      return { ok: false, reason: 'idle_expired' };
    }
    if (csrfToken !== undefined) {
      if (typeof csrfToken !== 'string' || !CSRF_TOKEN_PATTERN.test(csrfToken)) {
        return { ok: false, reason: 'csrf_mismatch' };
      }
      const expected = Buffer.from(row.csrf_token, 'utf8');
      const actual = Buffer.from(csrfToken, 'utf8');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return { ok: false, reason: 'csrf_mismatch' };
      }
    }
    touch.run(timestamp, row.session_hash);
    return {
      ok: true,
      operatorId: row.operator_id,
      role: row.role,
      csrfToken: row.csrf_token,
      createdAt: row.created_at,
      lastSeenAt: timestamp,
      expiresAt: row.expires_at,
    };
  }

  function revoke(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
    return remove.run(hashSessionId(sessionId)).changes > 0;
  }

  function sweep() {
    return sweepStatement.run(now()).changes;
  }

  function close() {
    db.close();
  }

  return { create, validate, revoke, sweep, close, hashSessionId, idleTtlMs, absoluteTtlMs };
}

module.exports = {
  SESSION_ID_BYTES,
  SESSION_ID_PATTERN,
  CSRF_TOKEN_PATTERN,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_ABSOLUTE_TTL_MS,
  MAX_IDLE_TTL_MS,
  MAX_ABSOLUTE_TTL_MS,
  hashSessionId,
  createOidcSessionStore,
};
