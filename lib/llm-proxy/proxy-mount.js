'use strict';

/**
 * Server wiring bridge for the transparent LLM proxy (#1908).
 *
 * server.js is under the file-size ratchet (#328) and may not grow, so this
 * bridge owns everything the dispatch line needs: memoized handler,
 * environment config, and default fetch. server.js only extends two existing
 * lines (a require and a dispatch condition) without adding any.
 */

const { createLlmProxyHandler } = require('./proxy-handler');
const { resolveProxyConfig } = require('./proxy-config');

let cachedHandler = null;

function handleLlmProxyRequest(req, res, reqUrl, deps = {}) {
  if (!cachedHandler) {
    cachedHandler = createLlmProxyHandler({
      graph: deps.graph,
      writeJson: deps.writeJson,
      config: resolveProxyConfig(),
    });
  }
  return cachedHandler.handleLlmProxy(req, res, reqUrl);
}

module.exports = {
  handleLlmProxyRequest,
};
