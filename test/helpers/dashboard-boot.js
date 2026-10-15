'use strict';

/**
 * Boot the assembled dashboard with a stubbed network, so UI contract tests can
 * assert what the page renders after a fetch instead of matching the script as
 * text. `public/index.html` loads the real modules into the shared vm harness;
 * the only thing faked here is the server.
 *
 * `routes` maps a URL prefix to a response body (or a function of the request).
 * The capability manifest and the auth probe are answered by default, because
 * every panel depends on them.
 */

const { run } = require('./dashboard-runtime');
const { publicWorkflowManifest } = require('../../lib/workflow-contract');

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

async function boot({ routes = {}, workflows = null, ticks = 50 } = {}) {
  const calls = [];
  const manifest = {
    contractVersion: 'v2',
    workflows: workflows === null ? publicWorkflowManifest().workflows : workflows,
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: (options.method || 'GET').toUpperCase(), body: options.body });
    if (url.startsWith('/health')) return ok({ apiAuthRequired: false });
    if (url.startsWith('/api/v2/workflows')) return ok(manifest);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return ok(typeof handler === 'function' ? handler(url, options) : handler);
      }
    }
    return ok({});
  };
  const page = await run({ fetch: fetchImpl, ticks });
  return { page, calls, callsTo: (prefix) => calls.filter((call) => call.url.startsWith(prefix)) };
}

module.exports = { boot, ok };
