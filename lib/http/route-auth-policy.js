'use strict';

/**
 * Central HTTP route authorization policy (issue #330).
 *
 * Before this module every endpoint in server.js had to remember to call
 * `denyIfUnauthorized(req, res)` by hand. Forgetting the call silently produced
 * a publicly readable endpoint and nothing failed. This module inverts that:
 * authorization is decided by one declarative table and the default is DENY.
 *
 * Two separate decisions are made here, and keeping them separate matters:
 *
 *   known   - is this path part of the served surface at all?
 *   public  - may it be reached without an API key?
 *
 * An unknown path must stay a generic 404 and must NOT become a 401, because a
 * 401 on an unrouted path tells an unauthenticated caller that the path exists.
 * The external-client route contract depends on that non-disclosure property.
 */

/**
 * Public (unauthenticated) routes.
 *
 * Every entry carries a `why` so that publishing a surface is a visible,
 * reviewable decision rather than an omission.
 */
const PUBLIC_ROUTES = Object.freeze([
  Object.freeze({
    id: 'health',
    match: Object.freeze({ pathname: '/health' }),
    methods: Object.freeze(['GET']),
    why: 'Liveness probe for orchestrators; exposes no graph content.',
  }),
  Object.freeze({
    id: 'v2-status',
    match: Object.freeze({ pathname: '/v2-status' }),
    methods: Object.freeze(['GET']),
    why: 'Roadmap/phase status board consumed by the bundled demo UI.',
  }),
  Object.freeze({
    id: 'index',
    match: Object.freeze({ pathname: '/' }),
    methods: Object.freeze(['GET']),
    why: 'Static demo HTML page.',
  }),
  Object.freeze({
    id: 'public-api-command',
    match: Object.freeze({ pathname: '/api' }),
    methods: Object.freeze(['GET']),
    why: 'Fixed-response command surface (selam/yardim/anlamadim) only. Workspace-backed commands reachable on this path — sor, durum — are gated on an API key by the handler, see requestGuards.commandRequiresAuthentication (#727).',
  }),
  Object.freeze({
    id: 'workflow-capabilities',
    match: Object.freeze({ pathname: '/api/v2/workflows' }),
    methods: Object.freeze(['GET']),
    why: 'Machine-readable description of workflow availability; exposes no workspace data.',
  }),
  Object.freeze({
    id: 'workflow-openapi',
    match: Object.freeze({ pathname: '/api/v2/openapi.json' }),
    methods: Object.freeze(['GET']),
    why: 'Generated contract for declared HTTP workflow routes; exposes no workspace data.',
  }),
]);

/**
 * Authenticated routes served by this process.
 *
 * Listing them is what lets an undeclared path stay a 404 instead of leaking
 * its existence through a 401.
 */
const AUTHENTICATED_ROUTES = Object.freeze([
  Object.freeze({ id: 'graph-data', match: Object.freeze({ pathname: '/graph-data' }) }),
  Object.freeze({ id: 'v2-verify', match: Object.freeze({ pathname: '/v2/verify' }) }),
  Object.freeze({ id: 'workflow-ask', match: Object.freeze({ pathname: '/api/v2/workflows/ask' }) }),
  Object.freeze({ id: 'workflow-verify', match: Object.freeze({ pathname: '/api/v2/workflows/verify' }) }),
  Object.freeze({ id: 'workflow-advocate', match: Object.freeze({ pathname: '/api/v2/workflows/advocate' }) }),
  Object.freeze({ id: 'workflow-search', match: Object.freeze({ pathname: '/api/v2/workflows/search' }) }),
  Object.freeze({ id: 'workflow-learn', match: Object.freeze({ pathname: '/api/v2/workflows/learn' }) }),
  Object.freeze({ id: 'llm-sor', match: Object.freeze({ pathname: '/llm-sor' }) }),
  Object.freeze({ id: 'dogrula', match: Object.freeze({ pathname: '/dogrula' }) }),
  Object.freeze({ id: 'verify', match: Object.freeze({ pathname: '/verify' }) }),
  Object.freeze({ id: 'yukle', match: Object.freeze({ pathname: '/yukle' }) }),
  Object.freeze({ id: 'upload', match: Object.freeze({ pathname: '/upload' }) }),
  Object.freeze({ id: 'ingest', match: Object.freeze({ pathname: '/api/ingest' }) }),
  Object.freeze({ id: 'ingest-status', match: Object.freeze({ pathname: '/api/ingest/status' }) }),
  Object.freeze({ id: 'ingest-approvals', match: Object.freeze({ prefix: '/api/ingest/approvals' }) }),
  Object.freeze({ id: 'workflow-ingest-preview', match: Object.freeze({ pathname: '/api/v2/ingest/preview' }) }),
  Object.freeze({ id: 'workflow-ingest-execute', match: Object.freeze({ pathname: '/api/v2/ingest/execute' }) }),
  Object.freeze({ id: 'workflow-ingest-runs', match: Object.freeze({ prefix: '/api/v2/ingest/runs/' }) }),
  Object.freeze({ id: 'workflow-approvals', match: Object.freeze({ prefix: '/api/v2/approvals' }) }),
  Object.freeze({ id: 'workflow-trust-receipts', match: Object.freeze({ prefix: '/api/v2/trust-receipts/' }) }),
  Object.freeze({ id: 'provenance', match: Object.freeze({ pathname: '/api/provenance' }) }),
  Object.freeze({ id: 'audit', match: Object.freeze({ pathname: '/api/audit' }) }),
  Object.freeze({ id: 'candidate-claims', match: Object.freeze({ pathname: '/api/candidate-claims' }) }),
  Object.freeze({ id: 'trust-receipt', match: Object.freeze({ pathname: '/api/trust-receipt' }) }),
  Object.freeze({ id: 'trust-receipt-by-id', match: Object.freeze({ prefix: '/api/trust-receipt/' }) }),
  Object.freeze({ id: 'workbench-trust-receipt', match: Object.freeze({ prefix: '/api/workbench/trust-receipt/' }) }),
  Object.freeze({ id: 'workbench-memory-context', match: Object.freeze({ prefix: '/api/workbench/memory-context/' }) }),
  Object.freeze({ id: 'workbench-receipt-bundle', match: Object.freeze({ pathname: '/api/workbench/receipt-bundle' }) }),
]);

function normalizeMethod(method) {
  return String(method || 'GET').toUpperCase();
}

function normalizePathname(pathname) {
  const raw = String(pathname || '');
  if (raw.length > 1 && raw.endsWith('/')) return raw.slice(0, -1);
  return raw;
}

function matchesRule(rule, pathname) {
  if (rule.match.pathname !== undefined) return rule.match.pathname === pathname;
  if (rule.match.prefix !== undefined) {
    const prefix = normalizePathname(rule.match.prefix);
    return pathname === prefix || pathname.startsWith(rule.match.prefix);
  }
  return false;
}

/**
 * Decide how a request should be treated before any handler runs.
 *
 * @returns {{ known: boolean, authRequired: boolean, ruleId: string, reason: string }}
 *   known=false        -> let the normal 404 path handle it, do not challenge
 *   authRequired=true  -> require a valid API key before dispatching
 */
function resolveRouteAuthPolicy(pathname, method = 'GET', context = {}) {
  const normalizedPath = normalizePathname(pathname);
  const normalizedMethod = normalizeMethod(method);

  // This route is intentionally absent until the server has fully materialized
  // its static profile and durable replay owner. A declared-but-unready route
  // would turn a configuration error into an externally observable 401.
  if (normalizedPath === '/api/external-client/packages/admit') {
    return context.externalClientRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'external-client-admission', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  for (const rule of PUBLIC_ROUTES) {
    if (!matchesRule(rule, normalizedPath)) continue;

    // A public rule only covers the methods it declares: a public GET does not
    // imply a public POST on the same path.
    if (!rule.methods.includes(normalizedMethod)) {
      return { known: true, authRequired: true, ruleId: rule.id, reason: 'method_not_public' };
    }

    if (rule.scope === 'default-workspace-only') {
      const requested = String(context.workspaceId || '');
      const isDefaultScope = !requested || requested === 'default';
      if (!isDefaultScope) {
        return { known: true, authRequired: true, ruleId: rule.id, reason: 'non_default_workspace' };
      }
    }

    return { known: true, authRequired: false, ruleId: rule.id, reason: 'public_route' };
  }

  for (const rule of AUTHENTICATED_ROUTES) {
    if (matchesRule(rule, normalizedPath)) {
      return { known: true, authRequired: true, ruleId: rule.id, reason: 'declared_authenticated' };
    }
  }

  // Not part of the declared surface. Stay silent: the 404 handler answers.
  return { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
}

function isPublicRoute(pathname, method, context) {
  const decision = resolveRouteAuthPolicy(pathname, method, context);
  return decision.known === true && decision.authRequired === false;
}

/** Route ids declared public, for tests and documentation. */
function listPublicRouteIds() {
  return PUBLIC_ROUTES.map((rule) => rule.id);
}

/** Route ids declared authenticated, for tests and documentation. */
function listAuthenticatedRouteIds() {
  return AUTHENTICATED_ROUTES.map((rule) => rule.id);
}

module.exports = {
  PUBLIC_ROUTES,
  AUTHENTICATED_ROUTES,
  resolveRouteAuthPolicy,
  isPublicRoute,
  listPublicRouteIds,
  listAuthenticatedRouteIds,
};
