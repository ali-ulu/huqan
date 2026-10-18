'use strict';

// Agent discovery, presence and the registry behind the Control Room's
// Agents view: discovery only reads, the user confirms, the registry and
// presence decide connected / disconnected / not connected.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { discoverAgents, stripJsonComments, huqanEntriesInToml } = require('../lib/http/agent-discovery');
const { agentIdForClient, createPresenceRecorder, readPresence } = require('../lib/mcp/agent-presence');
const { createAgentRegistryRoutes, CONNECTED_WINDOW_MS } = require('../lib/http/agent-registry-routes');
const { createJsonRpcHandler } = require('../lib/mcp/json-rpc-handler');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const { agentFootnote, discoveryState } = require('../public/control-room/js/control-room-agents');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fakeHome(t) {
  const home = tempDir(t, 'huqan-agent-home-');
  write(path.join(home, '.claude.json'), JSON.stringify({
    projects: { 'C:/work': { mcpServers: { huqan: { command: 'node', args: ['C:/huqan/mcpServer.js'], env: { HUQAN_API_KEY: 'secret-value' } } } } },
  }));
  fs.mkdirSync(path.join(home, '.claude'));
  write(path.join(home, '.codex', 'config.toml'), '[mcp_servers.memory]\ncommand = "levh"\n\n[mcp_servers.governance]\ncommand = "node"\nargs = ["C:/tools/huqan/mcpServer.js"]\n');
  write(path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), JSON.stringify({ mcpServers: { levh: { command: 'python' } } }));
  write(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '{\n  // servers\n  "mcp": { "servers": { "huqan-gate": { "command": ["npx", "huqan-mcp"], }, }, },\n}\n');
  return home;
}

test('discovery finds installed agents and whether HUQAN is in their settings', (t) => {
  const home = fakeHome(t);
  const result = Object.fromEntries(discoverAgents({ home, appData: '' }).map((a) => [a.id, a]));
  assert.equal(result['claude-code'].installed, true);
  assert.equal(result['claude-code'].huqanConfigured, true, 'a project-level mcpServers entry counts');
  assert.deepEqual(result.codex.entries, ['governance'], 'TOML: the server whose command names HUQAN');
  assert.equal(result.cline.installed, true);
  assert.equal(result.cline.huqanConfigured, false);
  assert.equal(result.opencode.huqanConfigured, true, 'JSONC with comments and trailing commas');
  assert.equal(result.cursor.installed, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret-value|mcpServer\.js|npx/, 'no config content, command or env value leaves discovery');
});

test('discovery has no write path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http', 'agent-discovery.js'), 'utf8');
  assert.doesNotMatch(source, /writeFile|appendFile|renameSync|unlink|rmSync|mkdirSync|createWriteStream|copyFile/);
});

test('discovery leaves every config file byte-identical', (t) => {
  const home = fakeHome(t);
  const files = ['.claude.json', path.join('.codex', 'config.toml'), path.join('.config', 'opencode', 'opencode.jsonc')]
    .map((f) => path.join(home, f));
  const before = files.map((f) => [fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs]);
  discoverAgents({ home, appData: '' });
  assert.deepEqual(files.map((f) => [fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs]), before);
});

test('JSONC comments are stripped outside strings only', () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{"url":"http://x//y", /* c */ "a":1, // d\n}')), { url: 'http://x//y', a: 1 });
  assert.deepEqual(huqanEntriesInToml('[mcp_servers."huqan"]\ncommand="x"'), ['huqan']);
  assert.deepEqual(huqanEntriesInToml('[mcp_servers.huqan]\ncommand="x"\n[mcp_servers.huqan.env]\nA="1"'), ['huqan'], 'a sub-table is the same server');
  assert.deepEqual(huqanEntriesInToml('[mcp_servers.huqan-gateway]\nargs = [\n  "C:/huqan/mcpServer.js",\n]\ncommand = "node"'), ['huqan-gateway'], 'HUQAN inside a multi-line args array is found');
  assert.deepEqual(huqanEntriesInToml('[mcp_servers.other]\nargs = [\n  "plain.js",\n]\ncommand = "node"'), [], 'a multi-line array without HUQAN stays unconfigured');
});

test('MCP client names map to catalog agents', () => {
  assert.equal(agentIdForClient('claude-code'), 'claude-code');
  assert.equal(agentIdForClient('claude-ai'), 'claude-ai', 'other Claude clients keep their own id instead of refreshing Claude Code');
  assert.equal(agentIdForClient('codex-mcp-client'), 'codex');
  assert.equal(agentIdForClient('Cline'), 'cline');
  assert.equal(agentIdForClient('Research Crew!'), 'research-crew');
  assert.equal(agentIdForClient(''), '');
});

test('presence is throttled, best-effort and records no tool data', (t) => {
  const dir = path.join(tempDir(t, 'huqan-presence-'), '.huqan-agent-presence');
  let now = Date.parse('2026-10-18T10:00:00Z');
  const record = createPresenceRecorder({ directory: dir, now: () => now });
  record({ clientName: 'claude-code' });
  now += 1000;
  record({ clientName: 'claude-code' });
  assert.equal(readPresence(dir).get('claude-code').lastSeen, '2026-10-18T10:00:00.000Z', 'second write inside the interval is skipped');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'claude-code.json'), 'utf8'))).sort(), ['client', 'id', 'lastSeen']);
  const broken = createPresenceRecorder({ directory: path.join(dir, 'claude-code.json', 'nested') });
  assert.doesNotThrow(() => broken({ clientName: 'codex' }), 'an unwritable presence directory never throws');
});

test('the MCP handler reports activity with the client name, and survives a failing hook', () => {
  const seen = [];
  const handler = createJsonRpcHandler({ callTool: () => ({ ok: true }), onActivity: (e) => seen.push(e.clientName) });
  handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '1' } } });
  handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'huqan.status', arguments: {} } });
  assert.deepEqual(seen, ['codex-mcp-client', 'codex-mcp-client']);
  const failing = createJsonRpcHandler({ callTool: () => ({ ok: true }), onActivity: () => { throw new Error('disk full'); } });
  failing({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'cline' } } });
  const res = failing({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(res.result, {});
});

function registryHarness(t, { now = Date.now() } = {}) {
  const directory = tempDir(t, 'huqan-registry-');
  const routes = createAgentRegistryRoutes({
    directory,
    now: () => now,
    discover: () => [{ id: 'codex', name: 'Codex', kind: 'Coding agent', installed: true, huqanConfigured: true, entries: ['huqan'], configFiles: [] }],
    parseJsonRequest: async (req) => req.body,
    writeJson: (req, res, status, body) => { res.status = status; res.body = body; },
  });
  async function call(method, pathname, { body, remote = '127.0.0.1' } = {}) {
    const req = { method, body, headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: remote } };
    const res = {};
    await routes.route(req, res, new URL(`http://x${pathname}`));
    return res;
  }
  return { call, directory };
}

test('discovery and registry changes answer only on this computer', async (t) => {
  const { call } = registryHarness(t);
  for (const [method, p, body] of [['GET', '/api/v2/agents/discovery'], ['POST', '/api/v2/agents', { id: 'codex' }], ['DELETE', '/api/v2/agents/codex']]) {
    const res = await call(method, p, { body, remote: '10.1.2.3' });
    assert.equal(res.status, 403, `${method} ${p} from another computer`);
  }
  assert.equal((await call('GET', '/api/v2/agents', { remote: '10.1.2.3' })).status, 200, 'reading the list is an ordinary authenticated read');
});

test('a confirmed agent joins the registry; unknown ids do not', async (t) => {
  const { call } = registryHarness(t);
  assert.equal((await call('POST', '/api/v2/agents', { body: { id: 'not-an-agent' } })).status, 400);
  const added = await call('POST', '/api/v2/agents', { body: { id: 'codex' } });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.data.agents.map((a) => [a.id, a.name, a.status]), [['codex', 'Codex', 'not_connected']]);
  const found = await call('GET', '/api/v2/agents/discovery');
  assert.equal(found.body.data.agents[0].registered, true);
  const removed = await call('DELETE', '/api/v2/agents/codex');
  assert.deepEqual(removed.body.data.agents, []);
});

test('status follows presence: connected, disconnected, not connected', async (t) => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const { call, directory } = registryHarness(t, { now });
  for (const id of ['claude-code', 'codex', 'cline']) await call('POST', '/api/v2/agents', { body: { id } });
  const presence = path.join(directory, '.huqan-agent-presence');
  write(path.join(presence, 'claude-code.json'), JSON.stringify({ id: 'claude-code', client: 'claude-code', lastSeen: new Date(now - 60_000).toISOString() }));
  write(path.join(presence, 'codex.json'), JSON.stringify({ id: 'codex', client: 'codex', lastSeen: new Date(now - CONNECTED_WINDOW_MS - 1).toISOString() }));
  write(path.join(presence, 'opencode.json'), JSON.stringify({ id: 'opencode', client: 'opencode', lastSeen: new Date(now).toISOString() }));
  const list = (await call('GET', '/api/v2/agents')).body.data;
  assert.deepEqual(Object.fromEntries(list.agents.map((a) => [a.id, a.status])), { 'claude-code': 'connected', codex: 'disconnected', cline: 'not_connected' });
  assert.deepEqual(list.seenUnregistered.map((a) => a.id), ['opencode'], 'a client seen but never added is offered, not added');
});

test('agent routes are declared, authenticated and unknown when not mounted', () => {
  for (const p of ['/api/v2/agents', '/api/v2/agents/discovery', '/api/v2/agents/codex']) {
    assert.equal(resolveRouteAuthPolicy(p, 'GET', {}).known, false);
    assert.equal(resolveRouteAuthPolicy(p, 'GET', { agentRegistryRouteEnabled: true }).authRequired, true);
  }
});

test('agent cards and discovery rows speak plain language', () => {
  const ago = () => '2 min ago';
  assert.equal(agentFootnote({ status: 'connected', lastSeen: 'x' }, ago), 'Last seen 2 min ago');
  assert.match(agentFootnote({ status: 'disconnected', lastSeen: 'x' }, ago), /not being watched/);
  assert.match(agentFootnote({ status: 'not_connected' }, ago), /has not sent anything/);
  assert.equal(discoveryState({ installed: true, huqanConfigured: false }), 'Installed, HUQAN is not in its settings yet');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'control-room', 'index.html'), 'utf8');
  assert.match(html, /id="agents-find"/);
  assert.doesNotMatch(html, /no agent registry/i);
});
