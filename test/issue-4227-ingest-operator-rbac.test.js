'use strict';

// #4227 (CWE-863): with MCP_OPERATOR_TOKEN configured, the HTTP ingest
// approval routes require an operator capability bound to the exact request,
// the same contract the MCP operator tools and the emergency-stop routes apply.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createIngestHttpRoutes } = require('../lib/http/ingest-http-routes');
const { createMcpOperatorCapability } = require('../lib/mcp-operator-capability');
const { operatorCapabilityBinding } = require('../lib/mcp/operator-authorization');

const SECRET = 'ingest-operator-secret';
const HEADER = 'x-huqan-operator-capability';

function capabilityFor(name, args) {
  return createMcpOperatorCapability({ secret: SECRET, ...operatorCapabilityBinding(name, args) });
}

function harness(options = {}) {
  const calls = { decide: [], responses: [] };
  const handle = createIngestHttpRoutes({
    kernel: options.kernel || {},
    approvalRuntime: {
      recover() {},
      getStore: () => ({ listUnresolvedToolApprovals: () => [] }),
      decide: async (args) => { calls.decide.push(args); return { status: 200, json: { ok: true } }; },
    },
    ensureCompanyRuntime() {},
    parseJsonRequest: async (req) => req.body,
    denyIfUnauthorized: () => true,
    writeJson: (req, res, status) => calls.responses.push(status),
    writeApiError: (req, res, status, code) => calls.responses.push(`${status} ${code}`),
    operatorToken: options.operatorToken === undefined ? SECRET : options.operatorToken,
    ...(options.nonces === false ? {} : { capabilityNonces: new Set() }),
  });
  const request = async (method, url, { capability, body } = {}) => {
    const req = { method, headers: capability === undefined ? {} : { [HEADER]: capability }, body };
    await handle(req, {}, new URL(url, 'http://localhost'), {});
    return calls.responses.at(-1);
  };
  return { request, calls };
}

const DECIDE_URL = '/api/ingest/approvals/appr-1?workspaceId=w1';
const DECIDE_ARGS = { approvalId: 'appr-1', workspaceId: 'w1', decision: 'approved', reason: 'ok' };

test('#4227: without an operator token the approval routes keep their old contract', async () => {
  const { request } = harness({ operatorToken: '' });
  assert.equal(await request('GET', '/api/ingest/approvals'), 200);
});

test('#4227: listing approvals needs a capability bound to the requested limit and workspace', async () => {
  const { request } = harness();
  assert.equal(await request('GET', '/api/ingest/approvals'), '403 OPERATOR_AUTH_REQUIRED');
  assert.equal(await request('GET', '/api/ingest/approvals', { capability: ['a', 'b'] }), '403 OPERATOR_AUTH_REQUIRED');

  const scoped = capabilityFor('huqan.approvals', { limit: 50, workspaceId: 'default' });
  assert.equal(await request('GET', '/api/ingest/approvals?workspaceId=w2', { capability: scoped }), '403 OPERATOR_AUTH_REQUIRED',
    'a capability for the default workspace does not list another one');
  const fresh = capabilityFor('huqan.approvals', { limit: 50, workspaceId: 'default' });
  assert.equal(await request('GET', '/api/ingest/approvals', { capability: fresh }), 200);
  assert.equal(await request('GET', '/api/ingest/approvals', { capability: fresh }), '403 OPERATOR_AUTH_REQUIRED',
    'a capability is single-use');
});

test('#4227: deciding an approval needs a capability bound to that exact decision', async () => {
  const { request, calls } = harness();
  const body = { decision: 'approved', reason: 'ok' };
  assert.equal(await request('POST', DECIDE_URL, { body }), '403 OPERATOR_AUTH_REQUIRED');

  const approve = capabilityFor('huqan.approve', DECIDE_ARGS);
  assert.equal(await request('POST', DECIDE_URL, { capability: approve, body: { decision: 'rejected', reason: 'ok' } }),
    '403 OPERATOR_AUTH_REQUIRED', 'an approve capability cannot carry a reject');
  assert.equal(calls.decide.length, 0, 'nothing is decided without a matching capability');

  assert.equal(await request('POST', DECIDE_URL, { capability: capabilityFor('huqan.approve', DECIDE_ARGS), body }), 200);
  assert.deepEqual(calls.decide, [DECIDE_ARGS], 'the decision that runs is the one the capability bound');
});

test('#4227: consumed nonces persist beside the memory store, or under the home state dir', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4227-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const args = { limit: 50, workspaceId: 'default' };

  const beside = harness({ nonces: false, kernel: { graph: { memoryPath: path.join(root, 'store', 'memory.json') } } });
  assert.equal(await beside.request('GET', '/api/ingest/approvals', { capability: capabilityFor('huqan.approvals', args) }), 200);
  assert.ok(fs.existsSync(path.join(root, 'store', '.huqan-capability-nonces')));

  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const home = harness({ nonces: false });
  assert.equal(await home.request('GET', '/api/ingest/approvals', { capability: capabilityFor('huqan.approvals', args) }), 200);
  assert.ok(fs.existsSync(path.join(root, '.local', 'state', 'huqan', '.huqan-capability-nonces')));
});
