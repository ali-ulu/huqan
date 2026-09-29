'use strict';

// The emergency stop's operator surfaces (#2505 F): the deployment-gated route
// rules they required moving, the HTTP route, and the CLI commands.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createEmergencyStop } = require('../lib/emergency-stop');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const {
  EMERGENCY_STOP_PATHNAME,
  EMERGENCY_STOP_TOOL,
  OPERATOR_CAPABILITY_HEADER,
  changeArguments,
  checkArguments,
  createEmergencyStopBoundary,
  createEmergencyStopRoutes,
} = require('../lib/http/emergency-stop-routes');
const { createMcpOperatorCapability } = require('../lib/mcp-operator-capability');
const { operatorCapabilityBinding } = require('../lib/mcp/operator-authorization');
const { runCliArgv, CLI_EXIT_CODES } = require('../lib/cli-workflow-adapter');

const UNKNOWN = { known: false, authRequired: false, ruleId: 'unknown', reason: 'unknown_route' };

function ledgerIn(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-emergency-stop-ops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createEmergencyStop({ directory: dir });
}

// Every deployment-gated rule, as it was decided before the rules moved out of
// route-auth-policy.js: unknown while its surface is unconfigured, declared
// once it is.
const GATED = [
  ['/api/command-policy', 'commandPolicyRouteEnabled', 'command-policy', true, 'declared_authenticated'],
  ['/api/command-policy/preview', 'commandPolicyRouteEnabled', 'command-policy', true, 'declared_authenticated'],
  ['/api/v5/receipts/batches', 'receiptCollectorRouteEnabled', 'receipt-collector-ingest', true, 'declared_authenticated'],
  ['/api/external-client/packages/admit', 'externalClientRouteEnabled', 'external-client-admission', true, 'declared_authenticated'],
  ['/api/v2/memory-approvals', 'memoryApprovalRouteEnabled', 'memory-approvals', true, 'declared_authenticated'],
  ['/api/v2/memory-approvals/a1/decision', 'memoryApprovalRouteEnabled', 'memory-approvals', true, 'declared_authenticated'],
  ['/api/v2/emergency-stops', 'emergencyStopRouteEnabled', 'emergency-stops', true, 'declared_authenticated'],
  ['/api/v2/pr-guardian/webhooks/github', 'prGuardianWebhookEnabled', 'pr-guardian-webhook', false, 'declared_hmac_authenticated'],
  ['/pr-guardian', 'prGuardianRouteEnabled', 'pr-guardian-ui', false, 'declared_public_shell'],
  ['/api/v2/pr-guardian/reviews', 'prGuardianRouteEnabled', 'pr-guardian', true, 'declared_authenticated'],
  ['/api/v2/pr-guardian/dry-run', 'prGuardianRouteEnabled', 'pr-guardian', true, 'declared_authenticated'],
  ['/api/v2/pr-guardian/reviews/r1/execute', 'prGuardianRouteEnabled', 'pr-guardian', true, 'declared_authenticated'],
  ['/api/a2a/exchange', 'a2aRouteEnabled', 'a2a-exchange', true, 'declared_authenticated'],
  ['/.well-known/agent-card.json', 'a2aAgentCardRouteEnabled', 'a2a-agent-card', true, 'declared_authenticated'],
  ['/api/a2a/negotiate', 'a2aNegotiateRouteEnabled', 'a2a-negotiate', true, 'declared_authenticated'],
  ['/api/registry/records', 'registryRouteEnabled', 'registry-records', true, 'declared_authenticated'],
  ['/api/registry/records/r1', 'registryRouteEnabled', 'registry-records', true, 'declared_authenticated'],
  ['/api/a2a/tasks/t1', 'a2aTaskRouteEnabled', 'a2a-task-read', true, 'declared_authenticated'],
];

test('every deployment-gated route is unknown until configured and declared once it is', () => {
  for (const [pathname, flag, ruleId, authRequired, reason] of GATED) {
    assert.deepEqual(resolveRouteAuthPolicy(pathname, 'GET', {}), UNKNOWN, `${pathname} unconfigured`);
    assert.deepEqual(
      resolveRouteAuthPolicy(pathname, 'POST', { [flag]: true }),
      { known: true, authRequired, ruleId, reason },
      `${pathname} configured`,
    );
  }
});

test('the command policy rule still matches the raw path, so a trailing slash is not the gated route', () => {
  const decision = resolveRouteAuthPolicy('/api/command-policy/', 'GET', { commandPolicyRouteEnabled: true });
  assert.notEqual(decision.ruleId, 'command-policy');
});

function fakeResponse() {
  return { status: null, body: null };
}

function routesWith(t, overrides = {}) {
  const ledger = ledgerIn(t);
  const routes = createEmergencyStopRoutes({
    operatorToken: 'stop-operator',
    emergencyStop: ledger,
    parseJsonRequest: async (req) => req.body,
    writeJson: (_req, res, status, body) => { res.status = status; res.body = body; },
    ...overrides,
  });
  return { ledger, routes };
}

function capabilityFor(args) {
  return createMcpOperatorCapability({ secret: 'stop-operator', ...operatorCapabilityBinding(EMERGENCY_STOP_TOOL, args) });
}

async function call(routes, { method, query = {}, body, capability }) {
  const reqUrl = new URL(`http://127.0.0.1${EMERGENCY_STOP_PATHNAME}`);
  for (const [key, value] of Object.entries(query)) reqUrl.searchParams.set(key, value);
  const req = { method, body, headers: capability ? { [OPERATOR_CAPABILITY_HEADER]: capability } : {} };
  const res = fakeResponse();
  const handled = await routes.route(req, res, reqUrl);
  return { handled, ...res };
}

test('the HTTP route does not exist without an operator token', () => {
  assert.equal(createEmergencyStopRoutes({ operatorToken: '' }), null);
  assert.equal(createEmergencyStopBoundary({ operatorToken: '' }).authContext.emergencyStopRouteEnabled, false);
  assert.equal(createEmergencyStopBoundary({ operatorToken: 'x', parseJsonRequest() {}, writeJson() {} }).authContext.emergencyStopRouteEnabled, true);
});

test('the HTTP route refuses a call without a capability bound to its exact arguments', async (t) => {
  const { routes, ledger } = routesWith(t);
  const body = { action: 'stop', scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'test' };
  const missing = await call(routes, { method: 'POST', body });
  assert.equal(missing.status, 403);
  const otherAgent = await call(routes, { method: 'POST', body, capability: capabilityFor(changeArguments({ ...body, agentId: 'a2' })) });
  assert.equal(otherAgent.status, 403, 'a capability for another agent must not authorize this one');
  assert.equal(ledger.check({ workspaceId: 'w', agentId: 'a1' }).stopped, false, 'a refused call writes nothing');
});

test('the HTTP route stops, reports and lifts an agent with operator capabilities', async (t) => {
  const { routes, ledger } = routesWith(t);
  const stopBody = { action: 'stop', scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'containment' };
  const stopped = await call(routes, { method: 'POST', body: stopBody, capability: capabilityFor(changeArguments(stopBody)) });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.data.created, true);
  assert.equal(stopped.body.data.record.actor, 'operator:http');

  const query = { workspaceId: 'w', agentId: 'a1' };
  const status = await call(routes, { method: 'GET', query, capability: capabilityFor(checkArguments(query)) });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.stopped, true);

  const liftBody = { action: 'lift', scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'reviewed' };
  const lifted = await call(routes, { method: 'POST', body: liftBody, capability: capabilityFor(changeArguments(liftBody)) });
  assert.equal(lifted.body.data.lifted, true);
  assert.equal(ledger.check({ workspaceId: 'w', agentId: 'a1' }).stopped, false);
});

test('the HTTP route rejects an unknown action and an invalid stop with 400', async (t) => {
  const { routes } = routesWith(t);
  const badAction = { action: 'pause', scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: '' };
  assert.equal((await call(routes, { method: 'POST', body: badAction, capability: capabilityFor(changeArguments(badAction)) })).status, 400);
  const noAgent = { action: 'stop', scope: 'agent', workspaceId: 'w', agentId: '', reason: '' };
  const refused = await call(routes, { method: 'POST', body: noAgent, capability: capabilityFor(changeArguments(noAgent)) });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'INVALID_INPUT');
  assert.equal((await call(routes, { method: 'PUT', body: {} })).status, 405);
});

test('the CLI stops and lifts through the ledger, with the operator recorded', async (t) => {
  const ledger = ledgerIn(t);
  const out = [];
  const stop = await runCliArgv(
    ['stop', '--scope', 'workspace', '--workspace', 'w-cli', '--reason', 'incident', '--json'],
    { stdout: (value) => out.push(value) },
    { emergencyStop: ledger },
  );
  assert.equal(stop.exitCode, CLI_EXIT_CODES.completed);
  assert.equal(stop.workflowId, 'emergency-stop');
  const envelope = JSON.parse(out[0]);
  assert.equal(envelope.workflowId, 'emergency-stop');
  assert.equal(envelope.data.record.actor, 'operator:cli');
  assert.equal(ledger.check({ workspaceId: 'w-cli', agentId: 'any' }).stopped, true);

  const lift = await runCliArgv(['lift', '--scope', 'workspace', '--workspace', 'w-cli'], { stdout: (value) => out.push(value) }, { emergencyStop: ledger });
  assert.equal(lift.exitCode, CLI_EXIT_CODES.completed);
  assert.equal(out[1], 'Lifted: workspace w-cli');
  assert.equal(ledger.check({ workspaceId: 'w-cli' }).stopped, false);
});

test('the CLI reports an invalid stop as invalid input and writes nothing', async (t) => {
  const ledger = ledgerIn(t);
  const err = [];
  const result = await runCliArgv(['stop', '--scope', 'agent', '--workspace', 'w'], { stderr: (value) => err.push(value) }, { emergencyStop: ledger });
  assert.equal(result.exitCode, CLI_EXIT_CODES.invalid_input);
  assert.match(err[0], /needs an agent id/);
  assert.equal(ledger.check({ workspaceId: 'w', agentId: 'anyone' }).stopped, false);
});

test('the HTTP route names an unknown action before it reaches the ledger', async (t) => {
  const { routes } = routesWith(t);
  const body = { action: 'pause', scope: 'workspace', workspaceId: 'w', agentId: '', reason: '' };
  const result = await call(routes, { method: 'POST', body, capability: capabilityFor(changeArguments(body)) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_ACTION');
});

test('a consumed operator capability survives a restart as refused (#3005)', async (t) => {
  const nonceDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-emergency-nonces-'));
  t.after(() => fs.rmSync(nonceDir, { recursive: true, force: true }));
  const body = { action: 'stop', scope: 'workspace', workspaceId: 'w', agentId: '', reason: 'replay' };
  const capability = capabilityFor(changeArguments(body));

  const first = routesWith(t, { capabilityNonceDir: nonceDir });
  assert.equal((await call(first.routes, { method: 'POST', body, capability })).status, 200);
  assert.equal(first.ledger.check({ workspaceId: 'w' }).stopped, true);

  // A fresh route over the same nonce directory stands in for a restart: the
  // process-local Map this replaced would have accepted the token again.
  const second = routesWith(t, { capabilityNonceDir: nonceDir });
  const replayed = await call(second.routes, { method: 'POST', body, capability });
  assert.equal(replayed.status, 403, 'a capability spent before the restart is refused after it');
  assert.equal(second.ledger.check({ workspaceId: 'w' }).stopped, false, 'the replay writes nothing');
});

test('the optional route boundaries mount the emergency stop behind the operator token', async (t) => {
  const { createOptionalRouteBoundaries } = require('../lib/http/optional-boundaries');
  const boundaries = createOptionalRouteBoundaries({
    memoryApproval: {
      operatorToken: 'stop-operator',
      getParseJsonRequest: () => async (req) => req.body,
      getWriteJson: () => (_req, res, status, body) => { res.status = status; res.body = body; },
    },
    emergencyStop: { emergencyStop: ledgerIn(t) },
  });
  assert.equal(boundaries.authContext.emergencyStopRouteEnabled, true);
  const res = {};
  const handled = await boundaries.route({ method: 'GET', headers: {} }, res, new URL(`http://127.0.0.1${EMERGENCY_STOP_PATHNAME}`));
  assert.equal(handled, true, 'the composite routes the emergency stop path');
  assert.equal(res.status, 403, 'and the route still demands an operator capability');
});
