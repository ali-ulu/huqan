'use strict';

/**
 * The single mount point for deployment-gated routes.
 *
 * `lib/a2a/routes.js` already made this argument for the A2A family: the
 * tempting shape for a new optional route -- one more constant, one more
 * enablement flag and one more dispatch line in `server.js` -- is the one thing
 * the file-size ledger in `scripts/check-file-size.js` exists to prevent
 * (issue #328). That file composes the four A2A routes so `server.js` carries
 * one line for all of them.
 *
 * The memory-approval route is the first optional route that is not A2A, so the
 * same argument now applies one level up. Composing here keeps `server.js` at
 * exactly one require, one construction, one `authContext` spread and one
 * dispatch for *every* deployment-gated route, present and future -- which is
 * why adding this route did not grow `server.js` at all.
 *
 * Ordering matters only in that each boundary claims its own pathnames, so no
 * route here can shadow another.
 */

const { createA2aBoundary } = require('../a2a/routes');
const { createMemoryApprovalBoundary } = require('./memory-approval-routes');

/**
 * Dependencies arrive as thunks rather than values.
 *
 * `server.js` builds its boundaries near the top of the file, before the
 * response helpers further down are initialized. Passing `writeJson` directly
 * would read a `const` in its temporal dead zone and throw at require time;
 * passing a function that returns it defers the read to the first request,
 * which is when it is actually needed.
 */
function createOptionalRouteBoundaries(options = {}) {
  const memoryApprovalOptions = options.memoryApproval || {};
  const a2a = createA2aBoundary(options.a2a || {});
  const memoryApproval = createMemoryApprovalBoundary({
    ...memoryApprovalOptions,
    parseJsonRequest: (...args) => memoryApprovalOptions.getParseJsonRequest()(...args),
    writeJson: (...args) => memoryApprovalOptions.getWriteJson()(...args),
  });

  return Object.freeze({
    authContext: Object.freeze({ ...a2a.authContext, ...memoryApproval.authContext }),
    async route(req, res, reqUrl) {
      if (await a2a.route(req, res, reqUrl)) return true;
      if (await memoryApproval.route(req, res, reqUrl)) return true;
      return false;
    },
  });
}

module.exports = Object.freeze({ createOptionalRouteBoundaries });
