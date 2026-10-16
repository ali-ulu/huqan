'use strict';

/**
 * Authorization for the deployment-gated routes.
 *
 * Each route here exists only while its surface is configured: an unconfigured
 * deployment answers "unknown" (a generic 404), never "authentication required"
 * (a 401 that would confirm the path exists). These rules are decided before
 * the public and authenticated tables in route-auth-policy.js, and they are
 * authoritative for their paths.
 *
 * They were the conditional block at the top of resolveRouteAuthPolicy. They
 * live in their own module so a new gated route -- the emergency stop was the
 * first that did not fit (#2505 F) -- can be declared without growing a file
 * the file-size ledger already records. The rules and their order are
 * unchanged.
 *
 * @returns {null|{ known: boolean, authRequired: boolean, ruleId: string, reason: string }}
 *   null when the path is not a deployment-gated route.
 */
function resolveDeploymentGatedRoute(pathname, normalizedPath, context = {}) {
  if (pathname === '/api/command-policy' || pathname === '/api/command-policy/preview') {
    return context.commandPolicyRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'command-policy', reason: 'declared_authenticated' }
      : { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };
  }

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

  // The emergency stop follows memory approvals for the same reason: stopping
  // or releasing an agent needs an operator capability the API key does not
  // grant, so the route exists only once an operator token is configured
  // (#2505 F).
  if (normalizedPath === '/api/v2/emergency-stops') {
    return context.emergencyStopRouteEnabled === true
      ? { known: true, authRequired: true, ruleId: 'emergency-stops', reason: 'declared_authenticated' }
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

  return null;
}

module.exports = { resolveDeploymentGatedRoute };
