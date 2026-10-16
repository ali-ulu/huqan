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
const { createNegotiateBoundary } = require('./negotiate-route');
const { createTaskReadBoundary } = require('./task-route');

/**
 * @returns {{
 *   route: (req, res, reqUrl) => Promise<boolean>,
 *   authContext: Readonly<Record<string, boolean>>,
 * }}
 *   `authContext` feeds `lib/http/route-auth-policy.js`, which needs an
 *   enablement flag per route to keep an unconfigured one a 404 rather than a
 *   401. It is one spreadable object rather than a flag per property so that
 *   adding a route never edits `server.js`: P0-C promised that, and a third
 *   named flag would have quietly broken the promise on the first route after
 *   it.
 */
function createA2aBoundary(options = {}) {
  const exchange = createA2aExchangeBoundary(options);
  const agentCard = createAgentCardBoundary(options);
  const negotiate = createNegotiateBoundary(options);
  const taskRead = createTaskReadBoundary(options);

  return Object.freeze({
    authContext: Object.freeze({
      a2aRouteEnabled: exchange !== null,
      a2aAgentCardRouteEnabled: agentCard !== null,
      a2aNegotiateRouteEnabled: negotiate !== null,
      a2aTaskRouteEnabled: taskRead !== null,
    }),
    async route(req, res, reqUrl) {
      if (exchange && await exchange.route(req, res, reqUrl)) return true;
      if (agentCard && agentCard.route(req, res, reqUrl)) return true;
      if (negotiate && await negotiate.route(req, res, reqUrl)) return true;
      if (taskRead && taskRead.route(req, res, reqUrl)) return true;
      return false;
    },
  });
}

module.exports = Object.freeze({ createA2aBoundary });
