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
const { createPrGuardianBoundary } = require('./pr-guardian-routes');
const { createRegistryBoundary } = require('../registry/registry-route');
const { createExternalActionReceiptCollectorRoute } = require('./external-action-receipt-collector-route');

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
  const prGuardianOptions = options.prGuardian || {};
  const prGuardian = createPrGuardianBoundary({
    ...prGuardianOptions,
    parseJsonRequest: (...args) => prGuardianOptions.getParseJsonRequest()(...args),
    writeJson: (...args) => prGuardianOptions.getWriteJson()(...args),
  });
  const receiptCollectorOptions = options.receiptCollector || {};
  const receiptCollectorRoot = String(receiptCollectorOptions.collectorRoot || '').trim();
  const receiptCollector = receiptCollectorRoot
    ? createExternalActionReceiptCollectorRoute({
      collectorRoot: receiptCollectorRoot,
      parseJsonRequest: (...args) => receiptCollectorOptions.getParseJsonRequest()(...args),
    })
    : () => false;

  // The registry shares the A2A options: it resolves identities and keys
  // through the same receiver authority the exchange enforces, so giving it a
  // configuration of its own would be a way to end up with two answers to
  // "which key is trusted".
  const registryOptions = options.registry || {};
  const registry = createRegistryBoundary({
    ...(options.a2a || {}),
    ...registryOptions,
    getParseJsonRequest: registryOptions.getParseJsonRequest || memoryApprovalOptions.getParseJsonRequest,
    getWriteJson: registryOptions.getWriteJson || memoryApprovalOptions.getWriteJson,
  });

  return Object.freeze({
    authContext: Object.freeze({
      ...a2a.authContext,
      ...memoryApproval.authContext,
      ...prGuardian.authContext,
      registryRouteEnabled: registry !== null,
      receiptCollectorRouteEnabled: Boolean(receiptCollectorRoot),
    }),
    async route(req, res, reqUrl) {
      if (await a2a.route(req, res, reqUrl)) return true;
      if (await memoryApproval.route(req, res, reqUrl)) return true;
      if (await prGuardian.route(req, res, reqUrl)) return true;
      if (registry && await registry.route(req, res, reqUrl)) return true;
      if (await receiptCollector(req, res, reqUrl)) return true;
      return false;
    },
  });
}

module.exports = Object.freeze({ createOptionalRouteBoundaries });
