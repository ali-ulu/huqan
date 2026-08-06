'use strict';

/**
 * Central HTTP route auth policy.
 *
 * server.js previously carried its auth decisions only as ~12 hand-written
 * `denyIfUnauthorized(req, res)` calls scattered through a long if/else
 * chain. Nothing related a route to a decision, so adding an endpoint without
 * auth was silent and invisible -- there was no list to be missing from.
 *
 * This table is that list. Every route server.js serves must appear here with
 * an explicit decision and a reason, and a test scans server.js to enforce
 * that. A new route with no entry fails the build rather than shipping open.
 *
 * `resolveRoutePolicy` defaults to `required` for anything unlisted, so the
 * failure direction is closed.
 *
 * One thing this deliberately does NOT do: turn an unknown path into a 401.
 * Unknown paths must keep returning the generic 404 they return today --
 * answering 401 would both break the reserved-route tests that assert a
 * generic 404 and disclose which paths exist. Default-deny here is a
 * policy-and-test invariant for declared routes, not a runtime catch-all.
 */

const AUTH_REQUIRED = 'required';
const AUTH_PUBLIC = 'public';

/**
 * Reason strings are load-bearing: a `public` entry is a decision someone has
 * to be able to review, not a default that crept in.
 */
const ROUTE_POLICIES = Object.freeze({
  '/health': Object.freeze({
    auth: AUTH_PUBLIC,
    reason: 'liveness probe; returns no instance data',
  }),
  '/': Object.freeze({
    auth: AUTH_PUBLIC,
    reason: 'serves the local dashboard shell',
  }),
  '/v2-status': Object.freeze({
    auth: AUTH_PUBLIC,
    reason: 'the bundled dashboard fetches this without a key; see the disclosure note below',
    disclosure: 'returns graph node/edge counts and runtime versions, so it does reveal instance activity',
  }),
  '/graph-data': Object.freeze({
    auth: AUTH_PUBLIC,
    reason: 'dashboard graph view; server.js additionally requires a key for any non-default workspace scope',
    disclosure: 'exposes default-workspace graph contents to an unauthenticated local caller',
  }),
  '/api': Object.freeze({
    auth: AUTH_PUBLIC,
    reason: 'intentional public read surface, restricted at the command level by isAllowedPublicCommand / isUnsafePublicApiCommand rather than by API key',
    disclosure: 'answers allowlisted read commands without a key',
  }),

  '/v2/verify': Object.freeze({ auth: AUTH_REQUIRED, reason: 'verification surface' }),
  '/llm-sor': Object.freeze({ auth: AUTH_REQUIRED, reason: 'model-backed query' }),
  '/dogrula': Object.freeze({ auth: AUTH_REQUIRED, reason: 'verification surface' }),
  '/verify': Object.freeze({ auth: AUTH_REQUIRED, reason: 'verification surface' }),
  '/yukle': Object.freeze({ auth: AUTH_REQUIRED, reason: 'ingest, mutating' }),
  '/upload': Object.freeze({ auth: AUTH_REQUIRED, reason: 'ingest, mutating' }),
  '/api/ingest': Object.freeze({ auth: AUTH_REQUIRED, reason: 'ingest, mutating' }),
  '/api/ingest/status': Object.freeze({ auth: AUTH_REQUIRED, reason: 'ingest state' }),
  '/api/ingest/approvals': Object.freeze({ auth: AUTH_REQUIRED, reason: 'approval queue, decision surface' }),
  '/api/provenance': Object.freeze({ auth: AUTH_REQUIRED, reason: 'provenance records' }),
  '/api/audit': Object.freeze({ auth: AUTH_REQUIRED, reason: 'audit records' }),
  '/api/candidate-claims': Object.freeze({ auth: AUTH_REQUIRED, reason: 'candidate claim records' }),
  '/api/trust-receipt': Object.freeze({ auth: AUTH_REQUIRED, reason: 'trust receipts' }),
});

/**
 * Path prefixes whose sub-paths share one policy, for routers that dispatch
 * below a mount point rather than on an exact pathname.
 */
const ROUTE_PREFIX_POLICIES = Object.freeze([
  Object.freeze({
    prefix: '/api/workbench/',
    auth: AUTH_REQUIRED,
    reason: 'workbench read router; every sub-route is an inspection surface',
  }),
  Object.freeze({
    prefix: '/viewer/',
    auth: AUTH_PUBLIC,
    reason: 'viewer gateway; holds its own session-cookie authorization',
  }),
]);

/**
 * @param {string} pathname
 * @returns {{auth: string, reason: string, listed: boolean, disclosure?: string}}
 */
function resolveRoutePolicy(pathname) {
  const path = typeof pathname === 'string' ? pathname : '';

  const exact = Object.prototype.hasOwnProperty.call(ROUTE_POLICIES, path)
    ? ROUTE_POLICIES[path]
    : null;
  if (exact) return { ...exact, listed: true };

  const prefixMatch = ROUTE_PREFIX_POLICIES.find((entry) => path.startsWith(entry.prefix));
  if (prefixMatch) {
    return { auth: prefixMatch.auth, reason: prefixMatch.reason, listed: true };
  }

  // Unlisted: closed by default. Callers must not translate this into a 401
  // for unknown paths -- see the module note.
  return { auth: AUTH_REQUIRED, reason: 'route has no explicit policy entry', listed: false };
}

/** True when `pathname` is a route this table has an explicit decision for. */
function isListedRoute(pathname) {
  return resolveRoutePolicy(pathname).listed;
}

function requiresAuth(pathname) {
  return resolveRoutePolicy(pathname).auth === AUTH_REQUIRED;
}

module.exports = {
  AUTH_REQUIRED,
  AUTH_PUBLIC,
  ROUTE_POLICIES,
  ROUTE_PREFIX_POLICIES,
  resolveRoutePolicy,
  isListedRoute,
  requiresAuth,
};
