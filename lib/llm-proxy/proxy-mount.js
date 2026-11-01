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
const { createIngressRecorder } = require('../conversation-ingress');
const { evaluateMemoryAdmission } = require('../memory-admission-gate');

let cachedHandler = null;
let cachedGraph = null;

function handleLlmProxyRequest(req, res, reqUrl, deps = {}) {
  // The memoized handler closes over the graph, so a different graph (a second
  // server instance in one process, or a test) must build its own handler.
  if (!cachedHandler || cachedGraph !== deps.graph) {
    cachedGraph = deps.graph;
    cachedHandler = createLlmProxyHandler({
      graph: deps.graph,
      writeJson: deps.writeJson,
      config: resolveProxyConfig(),
      recordConversationTurn: createIngressRecorder({
        graph: deps.graph,
        evaluateAdmission: evaluateMemoryAdmission,
      }),
    });
  }
  return cachedHandler.handleLlmProxy(req, res, reqUrl);
}

module.exports = {
  handleLlmProxyRequest,
};
