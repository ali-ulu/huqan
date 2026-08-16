'use strict';

/**
 * The A2A surface's single mount point.
 *
 * P0-B gave `server.js` one boundary to delegate to. P0-C adds a second, and
 * the tempting shape -- a second constant, a second enablement flag and a
 * second dispatch line in `server.js` -- is the one thing the file-size ledger
 * in `scripts/check-file-size.js` exists to prevent (issue #328). Composing
 * here instead keeps `server.js` at exactly one A2A line, so P0-D..P0-G can add
 * routes without ever touching it again.
 *
 * The composite always exists, even when nothing is configured. That lets
 * `server.js` drop its null checks; an unconfigured deployment simply has a
 * router that matches no path, which is the same answer as before.
 *
 * Order matters only in that each boundary claims one exact pathname, so no
 * route here can shadow another.
 */

const { createA2aExchangeBoundary } = require('./exchange-route');
const { createAgentCardBoundary } = require('./agent-card-route');

/**
 * @returns {{
 *   route: (req, res, reqUrl) => Promise<boolean>,
 *   exchangeEnabled: boolean,
 *   agentCardEnabled: boolean,
 * }}
 *   The enablement flags feed `lib/http/route-auth-policy.js`, which needs them
 *   to keep an unconfigured route a 404 rather than a 401.
 */
function createA2aBoundary(options = {}) {
  const exchange = createA2aExchangeBoundary(options);
  const agentCard = createAgentCardBoundary(options);

  return Object.freeze({
    exchangeEnabled: exchange !== null,
    agentCardEnabled: agentCard !== null,
    async route(req, res, reqUrl) {
      if (exchange && await exchange.route(req, res, reqUrl)) return true;
      if (agentCard && agentCard.route(req, res, reqUrl)) return true;
      return false;
    },
  });
}

module.exports = Object.freeze({ createA2aBoundary });
