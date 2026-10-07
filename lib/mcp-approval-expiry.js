'use strict';

/**
 * Pending-approval lifetime for MCP tool approvals (#3486).
 *
 * A pending MCP approval used to have no expiry: `saveMcpApproval` never set
 * `expiresAt`, so a row a reviewer never got to stayed approvable forever and
 * could be executed long after the action's risk was assessed. This module is
 * the missing half of the decision-time re-check the Human Oversight runtime
 * already performs on its own cases.
 *
 * The lifetime is a fixed default aligned with the Human Oversight case
 * lifetime (`DEFAULT_CASE_LIFETIME_MS`): an approval interval should not
 * outlive the review it belongs to. It is configurable through
 * `HUQAN_MCP_APPROVAL_TTL_MS` (AXIOM_ fallback) but cannot be switched off --
 * there is no "0 means never" path, because that would restore the unbounded
 * row this change exists to remove. A value below the floor is refused rather
 * than silently clamped, so a misconfiguration is visible instead of quietly
 * producing a nearly-instant or nearly-forever lifetime.
 *
 * The `expiresAt` instant lives in the approval row's `context`, which is
 * stored as JSON in the existing `context_json` column. No migration and no
 * schema change are needed, and rows written before this change (no
 * `expiresAt`) are not grandfathered: their effective expiry is derived from
 * `createdAt + TTL`, so an old pending row is treated as expired rather than
 * remaining approvable forever.
 */

const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const { DEFAULT_CASE_LIFETIME_MS } = require('./human-oversight-approval-runtime-primitives-values');

const MCP_APPROVAL_TTL_ENV = 'MCP_APPROVAL_TTL_MS';
// A minute is the shortest lifetime that still leaves a reviewer time to act;
// a week is far past any review the firewall would still consider current.
const MIN_MCP_APPROVAL_TTL_MS = 60 * 1000;
const MAX_MCP_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function invalidTtl(raw) {
  const error = new Error(
    `invalid MCP approval TTL configuration for ${MCP_APPROVAL_TTL_ENV}: `
    + `expected an integer between ${MIN_MCP_APPROVAL_TTL_MS} and ${MAX_MCP_APPROVAL_TTL_MS} milliseconds`,
  );
  error.code = 'HUQAN_MCP_APPROVAL_TTL_INVALID';
  error.field = MCP_APPROVAL_TTL_ENV;
  return error;
}

/**
 * Resolve the configured pending-approval lifetime in milliseconds.
 *
 * `readEnvironment` is injected so callers share the runtime's env shim
 * (AXIOM_ fallback and conflict check). Defaults to
 * `readCompatibleEnvironmentVariable`. Unset keeps the default; a present but
 * invalid value throws, so the failure is loud rather than an approval that
 * silently never expires.
 */
function resolveMcpApprovalTtlMs(readEnvironment = readCompatibleEnvironmentVariable) {
  const raw = readEnvironment(MCP_APPROVAL_TTL_ENV);
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CASE_LIFETIME_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_MCP_APPROVAL_TTL_MS || value > MAX_MCP_APPROVAL_TTL_MS) {
    throw invalidTtl(raw);
  }
  return value;
}

/**
 * The instant a pending approval stops being approvable, as an ISO timestamp.
 *
 * `createdAt` may be an ISO string or epoch milliseconds. An unparseable
 * `createdAt` yields `null`, which callers treat as "no derivable expiry" and
 * fail closed on rather than guessing a lifetime.
 */
function mcpApprovalExpiresAt(createdAt, ttlMs) {
  const created = typeof createdAt === 'number'
    ? createdAt
    : Date.parse(String(createdAt ?? ''));
  if (!Number.isFinite(created)) return null;
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return new Date(created + ttl).toISOString();
}

/**
 * Whether a pending approval has outlived its lifetime at `nowMs`.
 *
 * Prefers an explicit `expiresAt` on the row; a row without one (written
 * before this change) is measured from `createdAt + ttlMs`. Returns true when
 * an expiry is claimed but unparseable, so a malformed value fails closed.
 * Returns false only when the row is genuinely still inside its lifetime.
 */
function isMcpApprovalExpired({ expiresAt, createdAt, ttlMs, nowMs = Date.now() } = {}) {
  const explicit = expiresAt === undefined || expiresAt === null || expiresAt === ''
    ? null
    : Date.parse(String(expiresAt));
  const derived = explicit === null ? Date.parse(String(mcpApprovalExpiresAt(createdAt, ttlMs) ?? '')) : explicit;
  if (!Number.isFinite(derived)) return true;
  return derived <= nowMs;
}

module.exports = {
  MCP_APPROVAL_TTL_ENV,
  MIN_MCP_APPROVAL_TTL_MS,
  MAX_MCP_APPROVAL_TTL_MS,
  resolveMcpApprovalTtlMs,
  mcpApprovalExpiresAt,
  isMcpApprovalExpired,
};
