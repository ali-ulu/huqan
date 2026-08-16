'use strict';

/**
 * The Agent Card document (P0-C).
 *
 * `docs/task-packs/p0a-a2a-production-transport-scope-freeze.md` deferred this
 * to its own unit, and the reason it is its own unit is worth stating: a card is
 * a *claim about a deployment*, and the one failure mode that matters is a card
 * that claims more than the deployment does. So this module builds the document
 * from two sources only -- the receiver-owned authority for identity, and a
 * frozen table for capability -- and it has no way to express a capability that
 * does not have a route behind it.
 *
 * Identity is not invented here. `authority.expectedTarget` is the same record
 * `lib/a2a/bounded-exchange.js` binds an incoming exchange against, so the card
 * necessarily describes the agent that the exchange route would actually accept
 * as its target. A card and a rejection cannot disagree about who this is.
 *
 * What the card deliberately does NOT carry:
 *
 *   - trusted keys or any trust-root material. Publishing a key set is a
 *     disclosure decision and it belongs to P3's registry work, not here.
 *   - negotiated capability. Advertising is not negotiation; P0-D owns that.
 *   - anything the deployment cannot do, which is why `unsupported` is an
 *     explicit list rather than an omission.
 */

const PROTOCOL_VERSION = '0.2';
const AGENT_CARD_VERSION = 1;

/** Protocol versions this receiver will agree to, in descending preference. */
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([PROTOCOL_VERSION]);

/**
 * Where a caller turns an advertisement into an agreement (P0-D).
 *
 * Declared here rather than in `./negotiate-route` so the card stays the single
 * source of truth for the surface it describes, and so the route imports the
 * path from the document instead of the document importing it from the route --
 * which would be a require cycle through `./capability-negotiation`.
 *
 * Negotiation is not itself listed in `CAPABILITIES`: it is the mechanism for
 * agreeing on capabilities, not one of the things that can be agreed on.
 */
const NEGOTIATION = Object.freeze({
  path: '/api/a2a/negotiate',
  method: 'POST',
  protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
});

/**
 * Surfaces this repository does not implement at P0-C.
 *
 * Naming them in the document is the same discipline the task-packs use for
 * non-claims: a consumer that reads this card learns what is absent instead of
 * discovering it through a failed request, and a later unit that ships one of
 * these has to remove its line here, which makes the card's growth reviewable.
 */
const UNSUPPORTED_SURFACES = Object.freeze([
  // `capability-negotiation` was here until P0-D shipped it. Removing the line
  // is how a unit graduates, and the card's tests assert the list exactly so
  // that shipping a surface without updating this is a failure rather than a
  // quietly stale document.
  'task-lifecycle',
  'idempotency-keys',
  'cancellation',
  'streaming',
  'json-rpc',
]);

/**
 * The single capability this deployment actually serves.
 *
 * Frozen as a table rather than assembled per request so that adding an entry
 * is a source change with a diff, not a runtime condition.
 */
const CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'bounded-exchange',
    path: '/api/a2a/exchange',
    method: 'POST',
    contract: 'docs/v5/v5-d6-bounded-a2a-exchange.md',
    requestSchema: 'specs/huqan-trust-protocol/0.2/schemas/a2a-trust-evidence.schema.json',
  }),
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Build the card, or return null if the authority cannot describe this agent.
 *
 * Null rather than a partial card: a card missing its identity is worse than no
 * card, because a consumer would cache it. The route turns null into the same
 * unavailable answer an unconfigured deployment gives.
 */
function buildAgentCard(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return null;
  const target = authority.expectedTarget;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  if (!nonEmptyString(target.agentId) || !nonEmptyString(target.identityRef)
      || !nonEmptyString(target.identityHash) || !nonEmptyString(target.workspaceId)
      || !nonEmptyString(authority.authorityId)) {
    return null;
  }

  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    agentCardVersion: AGENT_CARD_VERSION,
    agent: Object.freeze({
      agentId: target.agentId,
      identityRef: target.identityRef,
      identityHash: target.identityHash,
      workspaceId: target.workspaceId,
    }),
    receiverAuthorityId: authority.authorityId,
    // Stated rather than implied. Every A2A surface in this repository is
    // authenticated, including this one, and a consumer should not have to
    // probe to find that out.
    authentication: Object.freeze({ required: true, scheme: 'api-key' }),
    capabilities: CAPABILITIES,
    negotiation: NEGOTIATION,
    unsupported: UNSUPPORTED_SURFACES,
  });
}

module.exports = Object.freeze({
  AGENT_CARD_VERSION,
  CAPABILITIES,
  NEGOTIATION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  UNSUPPORTED_SURFACES,
  buildAgentCard,
});
