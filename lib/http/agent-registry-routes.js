'use strict';

/**
 * The agent registry behind the Control Room's Agents view.
 *
 *   GET    /api/v2/agents             registered agents with connected /
 *                                     disconnected / not connected
 *   GET    /api/v2/agents/discovery   what discovery found on this computer
 *   POST   /api/v2/agents             register one agent the user confirmed
 *   DELETE /api/v2/agents/{id}        remove one from the registry
 *
 * Discovery reads the host's home directory, so it and every registry change
 * answer only a direct loopback request: a remote API-key holder must not be
 * able to inventory the machine or rewrite what it shows. Registering writes
 * HUQAN's own registry file only; an agent's configuration is never touched
 * (lib/http/agent-discovery.js has no write path).
 *
 * Status comes from presence (lib/mcp/agent-presence.js): seen in the last
 * CONNECTED_WINDOW_MS is "connected", seen earlier is "disconnected", never
 * seen through HUQAN is "not_connected".
 */

const fs = require('node:fs');
const path = require('node:path');
const { discoverAgents, agentCatalog } = require('./agent-discovery');
const { readPresence, presenceDirectory } = require('../mcp/agent-presence');
const { isDirectLoopbackRequest } = require('./operator-grant-routes');

const LIST_PATHNAME = '/api/v2/agents';
const DISCOVERY_PATHNAME = '/api/v2/agents/discovery';
const ITEM_PATTERN = /^\/api\/v2\/agents\/([a-z0-9][a-z0-9-]{0,63})$/;
const CONNECTED_WINDOW_MS = 15 * 60_000;
const MAX_AGENTS = 100;
const BODY_MAX_BYTES = 2048;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NO_STORE = Object.freeze({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });

function storeDirectory(kernel) {
  const memoryPath = kernel && kernel.graph && typeof kernel.graph.memoryPath === 'string' ? kernel.graph.memoryPath : '';
  return path.dirname(presenceDirectory(memoryPath));
}

function createRegistryFile(file) {
  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed.agents)
        ? parsed.agents.filter((a) => a && ID_PATTERN.test(String(a.id))).slice(0, MAX_AGENTS)
        : [];
    } catch (_) {
      return [];
    }
  }
  function write(agents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ agents }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return Object.freeze({ read, write });
}

function statusFor(lastSeen, now) {
  if (!lastSeen) return 'not_connected';
  return now - Date.parse(lastSeen) <= CONNECTED_WINDOW_MS ? 'connected' : 'disconnected';
}

function createAgentRegistryRoutes(options = {}) {
  const { kernel, parseJsonRequest, writeJson } = options;
  const directory = options.directory || storeDirectory(kernel);
  const registry = createRegistryFile(path.join(directory, '.huqan-agent-registry.json'));
  const presenceDir = options.presenceDirectory || path.join(directory, '.huqan-agent-presence');
  const discover = typeof options.discover === 'function' ? options.discover : () => discoverAgents();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const catalog = new Map(agentCatalog({ home: '', appData: '' }).map((a) => [a.id, a]));

  const fail = (req, res, status, code, message) => writeJson(req, res, status, { ok: false, error: { code, message } }, NO_STORE);
  const send = (req, res, data, status = 200) => writeJson(req, res, status, { ok: true, data }, NO_STORE);

  function listAgents() {
    const presence = readPresence(presenceDir);
    const at = now();
    const agents = registry.read().map((entry) => {
      const seen = presence.get(entry.id);
      const known = catalog.get(entry.id);
      return {
        id: entry.id,
        name: entry.name || (known && known.name) || entry.id,
        kind: entry.kind || (known && known.kind) || 'Agent',
        registeredAt: entry.registeredAt || null,
        lastSeen: seen ? seen.lastSeen : null,
        status: statusFor(seen && seen.lastSeen, at),
      };
    });
    const registered = new Set(agents.map((a) => a.id));
    const seenUnregistered = [...presence.values()]
      .filter((p) => !registered.has(p.id))
      .map((p) => ({ id: p.id, name: (catalog.get(p.id) || {}).name || p.id, lastSeen: p.lastSeen }));
    return { agents, seenUnregistered };
  }

  function requireLocal(req, res) {
    if (isDirectLoopbackRequest(req)) return true;
    fail(req, res, 403, 'AGENT_REGISTRY_LOCAL_ONLY', 'Agents can only be found and added on the computer running HUQAN.');
    return false;
  }

  async function register(req, res) {
    const body = await parseJsonRequest(req, res, { maxBytes: BODY_MAX_BYTES });
    if (!body) return;
    const id = String(body.id || '');
    const presence = readPresence(presenceDir);
    if (!ID_PATTERN.test(id) || (!catalog.has(id) && !presence.has(id))) {
      fail(req, res, 400, 'UNKNOWN_AGENT', 'Only an agent HUQAN found on this computer can be added.');
      return;
    }
    const current = registry.read();
    if (!current.some((a) => a.id === id)) {
      if (current.length >= MAX_AGENTS) { fail(req, res, 409, 'AGENT_REGISTRY_FULL', 'The agent list is full.'); return; }
      const known = catalog.get(id);
      registry.write([...current, { id, name: known ? known.name : id, kind: known ? known.kind : 'Agent', registeredAt: new Date(now()).toISOString() }]);
    }
    send(req, res, listAgents(), 201);
  }

  async function route(req, res, reqUrl) {
    const pathname = String(reqUrl?.pathname || '');
    const item = pathname.match(ITEM_PATTERN);
    if (pathname === DISCOVERY_PATHNAME) {
      if (req.method !== 'GET') { fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed'); return true; }
      if (!requireLocal(req, res)) return true;
      const registered = new Set(registry.read().map((a) => a.id));
      send(req, res, { agents: discover().map((a) => ({ ...a, registered: registered.has(a.id) })) });
      return true;
    }
    if (pathname === LIST_PATHNAME) {
      if (req.method === 'GET') { send(req, res, listAgents()); return true; }
      if (req.method !== 'POST') { fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed'); return true; }
      if (!requireLocal(req, res)) return true;
      await register(req, res);
      return true;
    }
    if (item && item[1] !== 'discovery') {
      if (req.method !== 'DELETE') { fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed'); return true; }
      if (!requireLocal(req, res)) return true;
      registry.write(registry.read().filter((a) => a.id !== item[1]));
      send(req, res, listAgents());
      return true;
    }
    return false;
  }

  return Object.freeze({ route });
}

function createAgentRegistryBoundary(options = {}) {
  const routes = options.kernel || options.directory ? createAgentRegistryRoutes(options) : null;
  return Object.freeze({
    authContext: Object.freeze({ agentRegistryRouteEnabled: routes !== null }),
    async route(req, res, reqUrl) {
      return routes ? routes.route(req, res, reqUrl) : false;
    },
  });
}

module.exports = Object.freeze({
  CONNECTED_WINDOW_MS,
  createAgentRegistryRoutes,
  createAgentRegistryBoundary,
});
