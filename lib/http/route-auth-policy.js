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
    id: 'graph-data',
    match: Object.freeze({ pathname: '/graph-data' }),
    methods: Object.freeze(['GET']),
    scope: 'default-workspace-only',
    why: 'The bundled local graph view reads the default workspace only; named workspaces remain authenticated.',
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
    id: 'dashboard-stylesheet',
    match: Object.freeze({ pathname: '/css/app.css' }),
    methods: Object.freeze(['GET']),
    why: 'Stylesheet linked by the demo HTML page; the page is public, so its styles must be too. Extracted from the inline <style> in #1894 and unserved until #1901.',
  }),
  Object.freeze({
    id: 'dashboard-script',
    match: Object.freeze({ pathname: '/js/app.js' }),
    methods: Object.freeze(['GET']),
    why: 'Script linked by the demo HTML page; the page is public, so the script that renders it must be too. Extracted from the inline <script> in #1895.',
  }),
  Object.freeze({
    id: 'dashboard-learn-review-script',
    match: Object.freeze({ pathname: '/js/learn-review.js' }),
    methods: Object.freeze(['GET']),
    why: 'Script linked by the public demo HTML page for its review-gated learn proposal panel.',
  }),
  Object.freeze({
    id: 'dashboard-ingest-run-script',
    match: Object.freeze({ pathname: '/js/ingest-run-detail.js' }),
    methods: Object.freeze(['GET']),
    why: 'Script linked by the public demo HTML page for its read-only ingest-run detail panel.',
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
  Object.freeze({
    id: 'observability-openapi',
    match: Object.freeze({ pathname: '/api/observability/openapi.json' }),
    methods: Object.freeze(['GET']),
    why: 'Generated contract for versioned observability routes; exposes no workspace data.',
  }),
  Object.freeze({
    id: 'public-badge-json',
    match: Object.freeze({ prefix: '/api/badge/' }),
    methods: Object.freeze(['GET']),
    why: 'Public Trust Badge verification payload (#1907): allowlisted disclosure fields only (verdict, decision, riskScore, createdAt, chain status); default workspace only.',
  }),
  Object.freeze({
    id: 'public-badge-svg',
    match: Object.freeze({ prefix: '/badge/' }),
    methods: Object.freeze(['GET']),
    why: 'Embeddable Trust Badge SVG (#1907): same allowlisted projection as public-badge-json, rendered as an image.',
  }),
  Object.freeze({
    id: 'public-trust-page',
    match: Object.freeze({ prefix: '/trust/' }),
    methods: Object.freeze(['GET']),
    why: 'Human-readable Trust verification page (#1907): same allowlisted projection as public-badge-json, rendered as HTML. No actor, reason or metadata leaves the process.',
  }),
]);

/**
 * Authenticated routes served by this process.
 *
 * Listing them is what lets an undeclared path stay a 404 instead of leaking
 * its existence through a 401.
 */
const AUTHENTICATED_ROUTES = Object.freeze([
  Object.freeze({ id: 'v2-verify', match: Object.freeze({ pathname: '/v2/verify' }) }),
  Object.freeze({ id: 'workflow-ask', match: Object.freeze({ pathname: '/api/v2/workflows/ask' }) }),
  Object.freeze({ id: 'workflow-verify', match: Object.freeze({ pathname: '/api/v2/workflows/verify' }) }),
  Object.freeze({ id: 'workflow-advocate', match: Object.freeze({ pathname: '/api/v2/workflows/advocate' }) }),
  Object.freeze({ id: 'workflow-search', match: Object.freeze({ pathname: '/api/v2/workflows/search' }) }),
  Object.freeze({ id: 'workflow-learn', match: Object.freeze({ pathname: '/api/v2/workflows/learn' }) }),
  Object.freeze({ id: 'llm-sor', match: Object.freeze({ pathname: '/llm-sor' }) }),
  Object.freeze({ id: 'answer', match: Object.freeze({ pathname: '/answer' }) }),
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
  Object.freeze({ id: 'workflow-agent-plan', match: Object.freeze({ pathname: '/api/v2/agent/plan' }) }),
  Object.freeze({ id: 'workflow-agent-runs', match: Object.freeze({ pathname: '/api/v2/agent/runs' }) }),
  Object.freeze({ id: 'provenance', match: Object.freeze({ pathname: '/api/provenance' }) }),
  Object.freeze({ id: 'audit', match: Object.freeze({ pathname: '/api/audit' }) }),
  Object.freeze({ id: 'candidate-claims', match: Object.freeze({ pathname: '/api/candidate-claims' }) }),
  Object.freeze({ id: 'v5-package-import', match: Object.freeze({ pathname: '/api/v5/packages' }) }),
  // Only the two subpaths the handler serves are declared. A prefix entry
  // here challenged the bare `/api/v5/preflight` (and any other subpath) with
  // a 401 for a route no handler owns; unserved paths stay unknown so the
  // central gate answers its silent 404 instead (#1879).
  Object.freeze({ id: 'v5-preflight-reader', match: Object.freeze({ pathname: '/api/v5/preflight/reader' }) }),
  Object.freeze({ id: 'v5-preflight-structural-signing', match: Object.freeze({ pathname: '/api/v5/preflight/structural-signing' }) }),
  Object.freeze({ id: 'trust-receipt', match: Object.freeze({ pathname: '/api/trust-receipt' }) }),
  Object.freeze({ id: 'trust-receipt-by-id', match: Object.freeze({ prefix: '/api/trust-receipt/' }) }),
  // Transparent LLM proxy (#1908). Authenticated on purpose: an unauthenticated
  // OpenAI-compatible endpoint would be an open relay on someone else's key.
  Object.freeze({ id: 'llm-proxy-chat', match: Object.freeze({ pathname: '/v1/chat/completions' }) }),
  Object.freeze({ id: 'llm-proxy-models', match: Object.freeze({ pathname: '/v1/models' }) }),
  Object.freeze({ id: 'workbench-trust-receipt', match: Object.freeze({ prefix: '/api/workbench/trust-receipt/' }) }),
  Object.freeze({ id: 'workbench-memory-context', match: Object.freeze({ prefix: '/api/workbench/memory-context/' }) }),
  Object.freeze({ id: 'workbench-receipt-bundle', match: Object.freeze({ pathname: '/api/workbench/receipt-bundle' }) }),
  Object.freeze({ id: 'workbench-activity', match: Object.freeze({ pathname: '/api/workbench/activity' }) }),
  Object.freeze({ id: 'observability', match: Object.freeze({ prefix: '/api/observability' }) }),
  // NOTE: pr-guardian reviews/dry-run/decision/execute have no table entries
  // on purpose. They are readiness-gated like the collector and the webhook
  // above: the conditional block in resolveRouteAuthPolicy is authoritative,
  // and a table entry would advertise unconditional auth coverage the handler
  // only provides while configured (#1879).
  Object.freeze({ id: 'fitness-dashboard', match: Object.freeze({ pathname: '/fitness-dashboard' }) }),
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
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
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

  // The collector is an optional deployment surface. Keep it undiscoverable
  // until an operator has supplied durable storage for incoming receipts.
  if (normalizedPath === '/api/v5/receipts/batches') {
    return context.receiptCollectorRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'receipt-collector-ingest', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // This route is intentionally absent until the server has fully materialized
  // its static profile and durable replay owner. A declared-but-unready route
  // would turn a configuration error into an externally observable 401.
  if (normalizedPath === '/api/external-client/packages/admit') {
    return context.externalClientRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'external-client-admission', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // Same shape and reason as the two routes above, for a third: memory-admission
  // approval exists only once an operator token is configured. The route needs a
  // credential the API key does not grant -- otherwise whoever may propose a
  // memory write could approve it -- so an unconfigured deployment must answer
  // 404 rather than advertise a surface it will always refuse.
  if (normalizedPath === '/api/v2/memory-approvals'
      || /^\/api\/v2\/memory-approvals\/[^/]+\/decision$/.test(normalizedPath)) {
    return context.memoryApprovalRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'memory-approvals', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // GitHub owns webhook transport authentication: the handler requires a
  // valid x-hub-signature-256 HMAC before reading the payload. It is declared
  // only while a webhook secret is configured, so an unconfigured deployment
  // does not advertise the endpoint.
  if (normalizedPath === '/api/v2/pr-guardian/webhooks/github') {
    return context.prGuardianWebhookEnabled === true
      ? { known: true, authRequired: false, ruleId: 'pr-guardian-webhook', reason: 'declared_hmac_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // The Review Console shell follows its own API, not the static-asset rule it
  // used to sit under (issue #1826).
  //
  // A shell that always loads told the operator nothing about whether the
  // backend behind it exists: an unconfigured deployment served token and
  // dry-run controls over routes that answer 404 by design, so "the page is
  // there" read as "the capability is there". Deriving the shell from
  // `prGuardianRouteEnabled` makes the HTML load itself the readiness signal,
  // and keeps the console's disclosure identical to the API it drives rather
  // than one step ahead of it.
  if (normalizedPath === '/pr-guardian') {
    return context.prGuardianRouteEnabled === true
      ? { known: true, authRequired: false, ruleId: 'pr-guardian-ui', reason: 'declared_public_shell' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  if (normalizedPath === '/api/v2/pr-guardian/reviews'
      || normalizedPath === '/api/v2/pr-guardian/dry-run'
      || /^\/api\/v2\/pr-guardian\/reviews\/[^/]+\/(decision|execute)$/.test(normalizedPath)) {
    return context.prGuardianRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'pr-guardian', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // Same shape and reason as the external-client route above: the A2A
  // exchange exists only once the operator has supplied a receiver authority
  // and a replay directory. An unconfigured deployment must answer 404, not
  // 401, so a missing configuration does not advertise the surface.
  if (normalizedPath === '/api/a2a/exchange') {
    return context.a2aRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'a2a-exchange', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // The Agent Card follows the exchange route's shape for the same reason, and
  // is authenticated for one of its own: the card names an agent, its workspace
  // and the identity hash an exchange binds against. A `.well-known` path
  // conventionally implies public, so the departure is stated here rather than
  // left to be inferred from this table's default-deny.
  if (normalizedPath === '/.well-known/agent-card.json') {
    return context.a2aAgentCardRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'a2a-agent-card', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // Negotiation is gated on the same configuration as the exchange it can agree
  // to, so an unconfigured deployment cannot be talked into an agreement about a
  // route it does not serve.
  if (normalizedPath === '/api/a2a/negotiate') {
    return context.a2aNegotiateRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'a2a-negotiate', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // The registry follows the exchange route's shape for the same reason, and is
  // authenticated for one of its own: a registry record binds an identity to a
  // trust root, so reading one tells the caller which key the receiver will
  // accept for that agent. The record id is derived from the identity and is
  // therefore guessable by anyone who knows the identity -- which is exactly
  // why unguessability is not doing any authorization work here.
  if (normalizedPath === '/api/registry/records'
      || /^\/api\/registry\/records\/[^/]+$/.test(normalizedPath)) {
    return context.registryRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'registry-records', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

  // Task reads are a prefix rather than an exact path, and are authenticated for
  // a reason worth stating: a task record names an exchange this receiver
  // admitted. Task ids are unguessable, but unguessability is not an
  // authorization decision and must not be used as one.
  if (normalizedPath.startsWith('/api/a2a/tasks/')) {
    return context.a2aTaskRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'a2a-task-read', reason: 'declared_authenticated' }
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
