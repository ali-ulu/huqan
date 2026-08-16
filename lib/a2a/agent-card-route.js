'use strict';

/**
 * The Agent Card discovery route (P0-C): `GET /.well-known/agent-card.json`.
 *
 * Two decisions in here are deliberate and would otherwise look like
 * oversights.
 *
 * **The card is authenticated.** A well-known path usually implies a public
 * one, and for a plain service directory that would be right. This is not that:
 * invariant 6 of the P0 scope freeze says no A2A route is public, and the card
 * names an agent, its workspace and the exact identity hash an exchange binds
 * against. Serving that to an unauthenticated caller is a disclosure decision
 * with its own threat model, so it is left to whoever wants to make it
 * explicitly rather than inherited from a URL convention.
 *
 * **An unconfigured deployment has no card, not an empty one.** The boundary is
 * built from the same configuration the exchange route needs, so the card
 * cannot advertise `/api/a2a/exchange` on a deployment where that route answers
 * 404. A card is a claim; this is the wiring that keeps the claim true.
 *
 * The authority reader is `lib/a2a/exchange-route.js`'s, reused rather than
 * reimplemented -- a second reader with slightly different symlink rules would
 * be a way to serve a card built from a trust root the exchange would reject.
 */

const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { writeJson } = require('../server-response-helpers');
const { readReceiverAuthority } = require('./exchange-route');
const { buildAgentCard } = require('./agent-card');

const AGENT_CARD_PATH = '/.well-known/agent-card.json';

const AGENT_CARD_ROUTE_ERRORS = Object.freeze({
  METHOD: 'agent_card_method_not_allowed',
});

/**
 * Resolve the card once, at construction.
 *
 * The authority is already read once per process for the exchange route, and an
 * operator edit there needs a restart to take effect. The card follows that
 * same lifetime on purpose: a card that could drift from the trust root the
 * exchange is enforcing would be the exact inconsistency this route exists to
 * prevent.
 */
function createAgentCardBoundary(options = {}) {
  const configured = options.authorityFile !== undefined || options.replayDirectory !== undefined;
  const authorityFile = configured
    ? (options.authorityFile || '')
    : (readCompatibleEnvironmentVariable('A2A_AUTHORITY_FILE') || '');
  const replayDirectory = configured
    ? (options.replayDirectory || '')
    : (readCompatibleEnvironmentVariable('A2A_REPLAY_DIR') || '');
  // Both, not just the authority: the capability this card advertises is
  // unreachable without the replay owner, so a card served here would name a
  // route the deployment does not answer.
  if (!authorityFile || !replayDirectory) return null;

  let card;
  try {
    card = buildAgentCard(readReceiverAuthority(authorityFile));
  } catch (_) {
    return null;
  }
  if (!card) return null;

  return Object.freeze({ path: AGENT_CARD_PATH, handle, route });

  /** Router form, matching the exchange boundary so server.js only delegates. */
  function route(req, res, reqUrl) {
    if (reqUrl.pathname !== AGENT_CARD_PATH) return false;
    const descriptor = handle(req);
    writeJson(req, res, descriptor.statusCode, descriptor.body, { 'Cache-Control': 'no-store' });
    return true;
  }

  function handle(req) {
    if (String(req.method || '').toUpperCase() !== 'GET') {
      return Object.freeze({
        statusCode: 405,
        body: Object.freeze({ decision: 'block', reason: AGENT_CARD_ROUTE_ERRORS.METHOD }),
      });
    }
    return Object.freeze({ statusCode: 200, body: card });
  }
}

module.exports = Object.freeze({
  AGENT_CARD_PATH,
  AGENT_CARD_ROUTE_ERRORS,
  createAgentCardBoundary,
});
