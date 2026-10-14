'use strict';

// #3892 (#3860 P6b, ADR-016 "Operational approvals"): operator surfaces with
// no approval row answer to the approval authority through one guard. Legacy
// passes through; service mode needs the authority's consumed decision for
// exactly the arguments acted on; an unusable authority and a guard that
// throws both refuse.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalActionHash } = require('../lib/mcp-operator-capability');
const { signDecision, DECISION_VERSION } = require('../lib/authority/decision-envelope');
const { signConsumption } = require('../lib/authority/consumption-envelope');
const {
  OPERATIONAL_TOOLS,
  isOperationalTool,
  operationalRequestCommand,
  requireOperationalDecision,
} = require('../lib/authority/operational-guard');
const { buildOperationalRegistration } = require('../lib/authority/registration-payload');
const { validateRegistration } = require('../lib/authority/approval-registration');
const { createEmergencyStop } = require('../lib/emergency-stop');
const { callTool, createServer } = require('../mcpServer');

// Surfaces verify at the wall clock, so the envelopes are minted around it.
const NOW = Date.now();
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const signing = crypto.generateKeyPairSync('ed25519');
const SERVICE = Object.freeze({ mode: 'service', boundary: 'os-service', pin: { signingKey: signing.publicKey } });
const LEGACY = Object.freeze({ mode: 'legacy', boundary: 'same-user' });
const UNUSABLE = Object.freeze({ mode: 'required_unavailable', reason: 'install_path_untrusted' });

function decisionFor({ approvalId, tool, workspaceId, args }, overrides = {}, key = signing.privateKey) {
  const actionHash = canonicalActionHash({ tool, workspaceId, approvalId, arguments: args });
  const envelope = signDecision({ v: DECISION_VERSION, approvalId, workspaceId, tool, actionHash, decision: 'approved',
    reason: '', decidedAt: at(-60_000), validUntil: at(9 * 60_000), ledgerSeq: 3,
    ledgerHash: 'b'.repeat(64), operator: 'totp:primary', ...overrides }, key);
  const consumption = signConsumption({ approvalId, workspaceId, tool, actionHash, ledgerSeq: 4, ledgerHash: 'c'.repeat(64),
    consumedAt: at(-30_000) }, key);
  return { approvalId, envelope, consumption };
}

const LIFT = Object.freeze({ action: 'lift', scope: 'workspace', workspaceId: 'ws-1', agentId: '', reason: 'incident closed' });
const LIFT_BINDING = Object.freeze({ approvalId: 'ops-1', tool: OPERATIONAL_TOOLS.EMERGENCY_STOP, workspaceId: 'ws-1', args: LIFT });

const guard = (fields = {}) => requireOperationalDecision({ mode: SERVICE, tool: LIFT_BINDING.tool, workspaceId: 'ws-1',
  args: LIFT, authority: decisionFor(LIFT_BINDING), now: NOW, ...fields });

test('legacy mode passes through without any envelope', () => {
  assert.deepEqual(guard({ mode: LEGACY, authority: undefined }), { ok: true, boundary: 'same-user' });
});

test('service mode accepts the consumed decision for exactly these arguments', () => {
  assert.deepEqual(guard(), { ok: true, boundary: 'os-service', approvalId: 'ops-1' });
});

test('service mode without a decision refuses and names the command that registers it', () => {
  const result = guard({ authority: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTHORITY_DECISION_REQUIRED');
  assert.equal(result.request, operationalRequestCommand({ tool: LIFT_BINDING.tool, workspaceId: 'ws-1', args: LIFT }));
  assert.match(result.request, /^huqan-authority request huqan\.emergency_stop --workspace 'ws-1' --args '\{/);
});

test('an authority that is required but unusable refuses even a valid decision', () => {
  const result = guard({ mode: UNUSABLE });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTHORITY_UNAVAILABLE');
});

test('a decision for other arguments, another workspace, another key or without consumption is refused', () => {
  const cases = [
    [{ args: { ...LIFT, reason: 'something else' } }, 'AUTHORITY_DECISION_INVALID'],
    [{ workspaceId: 'ws-2' }, 'AUTHORITY_DECISION_INVALID'],
    [{ authority: decisionFor(LIFT_BINDING, {}, crypto.generateKeyPairSync('ed25519').privateKey) }, 'AUTHORITY_DECISION_INVALID'],
    [{ authority: { ...decisionFor(LIFT_BINDING), consumption: undefined } }, 'AUTHORITY_CONSUMPTION_REQUIRED'],
    [{ tool: OPERATIONAL_TOOLS.AGENT_RESUME }, 'AUTHORITY_DECISION_INVALID'],
  ];
  for (const [fields, code] of cases) {
    const result = guard(fields);
    assert.equal(result.ok, false, JSON.stringify(fields));
    assert.equal(result.code, code, JSON.stringify(fields));
  }
});

test('a guard that throws while verifying refuses instead of letting the action through', () => {
  let reads = 0;
  // Answers the legacy check, then throws: the failure lands in the guard's own catch.
  const flaky = { boundary: 'os-service', pin: SERVICE.pin, get mode() { reads += 1; if (reads > 1) throw new Error('mode vanished'); return 'service'; } };
  const result = guard({ mode: flaky });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTHORITY_DECISION_INVALID');
  assert.match(result.message, /mode vanished/);
  const exploding = { mode: 'service', boundary: 'os-service', get pin() { throw new Error('pin vanished'); } };
  assert.equal(guard({ mode: exploding }).ok, false);
});

test('a refusal is still returned when the arguments cannot be printed', () => {
  const result = guard({ authority: undefined, args: { big: 1n } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTHORITY_DECISION_REQUIRED');
  assert.equal(result.request, null);
});

test('only the four operational surfaces are operational tools', () => {
  for (const tool of Object.values(OPERATIONAL_TOOLS)) assert.equal(isOperationalTool(tool), true, tool);
  for (const tool of ['huqan.learn', 'huqan.approve', 'axiom.learn', '']) assert.equal(isOperationalTool(tool), false, tool);
  assert.equal(isOperationalTool('axiom.agent_resume'), true, 'the legacy alias is canonicalised');
});

test('an operational registration is accepted by the authority and gets a fresh id each time', () => {
  const input = { tool: 'axiom.agent_resume', workspaceId: 'ws-1', args: { goal: 'g' }, consumeKey: crypto.randomBytes(32),
    now: NOW, ttlMs: 60 * 60 * 1000 };
  const first = buildOperationalRegistration(input);
  const second = buildOperationalRegistration(input);
  assert.match(first.approvalId, /^ops-[0-9a-f]{24}$/);
  assert.notEqual(first.approvalId, second.approvalId);
  assert.equal(first.tool, OPERATIONAL_TOOLS.AGENT_RESUME);
  const checked = validateRegistration(first, NOW);
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

function withStopDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ops-stop-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('stopping is never guarded, lifting needs the authority, and a refused lift leaves the stop in place', () => withStopDir((dir) => {
  const ledger = createEmergencyStop({ directory: dir, resolveAuthorityMode: () => SERVICE });
  const stopped = ledger.stop({ scope: 'workspace', workspaceId: 'ws-1', reason: 'incident', actor: 'operator:cli' });
  assert.equal(stopped.created, true, 'a stop goes through with an authority installed and no decision');

  const refused = ledger.lift({ scope: 'workspace', workspaceId: 'ws-1', reason: 'incident closed', actor: 'operator:cli' });
  assert.equal(refused.ok, false);
  assert.equal(refused.lifted, false);
  assert.equal(refused.authorityRefusal.code, 'AUTHORITY_DECISION_REQUIRED');
  assert.equal(ledger.check({ workspaceId: 'ws-1' }).stopped, true, 'the refused lift changed nothing');

  const lifted = ledger.lift({ scope: 'workspace', workspaceId: 'ws-1', reason: 'incident closed', actor: 'operator:authority',
    authority: { ...decisionFor(LIFT_BINDING), mode: SERVICE } });
  assert.equal(lifted.lifted, true, JSON.stringify(lifted));
  assert.equal(ledger.check({ workspaceId: 'ws-1' }).stopped, false);
}));

test('a lift with a decision for another reason is refused', () => withStopDir((dir) => {
  const ledger = createEmergencyStop({ directory: dir, resolveAuthorityMode: () => SERVICE });
  ledger.stop({ scope: 'workspace', workspaceId: 'ws-1', reason: 'incident', actor: 'operator:cli' });
  const refused = ledger.lift({ scope: 'workspace', workspaceId: 'ws-1', reason: 'not what was decided', actor: 'operator:cli',
    authority: { ...decisionFor(LIFT_BINDING), mode: SERVICE } });
  assert.equal(refused.authorityRefusal.code, 'AUTHORITY_DECISION_INVALID');
  assert.equal(ledger.check({ workspaceId: 'ws-1' }).stopped, true);
}));

test('legacy lift is unchanged', () => withStopDir((dir) => {
  const ledger = createEmergencyStop({ directory: dir, resolveAuthorityMode: () => LEGACY });
  ledger.stop({ scope: 'workspace', workspaceId: 'ws-1', reason: 'incident', actor: 'operator:cli' });
  assert.equal(ledger.lift({ scope: 'workspace', workspaceId: 'ws-1', reason: 'done', actor: 'operator:cli' }).lifted, true);
}));

test('MCP lift carries the envelopes apply hands it into the guarded ledger', () => withStopDir((dir) => {
  const { createMcpOperatorCapability } = require('../lib/mcp-operator-capability');
  const { operatorCapabilityBinding } = require('../lib/mcp/operator-authorization');
  const ledger = createEmergencyStop({ directory: dir, resolveAuthorityMode: () => SERVICE });
  ledger.stop({ scope: 'workspace', workspaceId: 'ws-1', reason: 'incident', actor: 'operator:cli' });
  const server = createServer({ kernel: {} });
  try {
    const args = { action: 'lift', scope: 'workspace', workspaceId: 'ws-1', reason: 'incident closed' };
    const decision = decisionFor(LIFT_BINDING);
    const lifted = callTool(server.kernel, { name: 'huqan.emergency_stop', arguments: args,
      operatorCapability: createMcpOperatorCapability({ secret: 'op-3892', ...operatorCapabilityBinding('huqan.emergency_stop', args) }) },
    { operatorSecret: 'op-3892', operatorCapabilityNonces: new Map(), emergencyStop: ledger, approvalAuthorityMode: SERVICE,
      authorityApprovalId: decision.approvalId, authorityDecision: decision.envelope, authorityConsumption: decision.consumption });
    assert.equal(lifted.ok, true, JSON.stringify(lifted.error));
    assert.equal(lifted.data.lifted, true);
    assert.equal(ledger.check({ workspaceId: 'ws-1' }).stopped, false);
  } finally {
    server.kernel.graph?.close?.();
    server.approvalStore?.close?.();
  }
}));

const RESUME = Object.freeze({ goal: 'resume safely', workspaceId: 'ws-1', checkpointId: 'cp-1', resumeToken: 'cp-1' });

function resumeThroughMcp(runtime) {
  const server = createServer({ kernel: {} });
  try {
    return callTool(server.kernel, { name: 'huqan.agent_resume', operatorToken: 'operator-3892', arguments: RESUME },
      { approvalStore: server.approvalStore, operatorToken: 'operator-3892', ...runtime });
  } finally {
    server.kernel.graph?.close?.();
    server.approvalStore?.close?.();
  }
}

test('MCP agent resume refuses in service mode before the agent runs and says how to register it', () => {
  const result = resumeThroughMcp({ approvalAuthorityMode: SERVICE });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTHORITY_DECISION_REQUIRED');
  assert.match(result.meta.authority.request, /huqan-authority request huqan\.agent_resume/);
});

test('MCP agent resume refuses a decision bound to other resume arguments', () => {
  const other = decisionFor({ approvalId: 'ops-2', tool: OPERATIONAL_TOOLS.AGENT_RESUME, workspaceId: 'ws-1',
    args: { ...RESUME, resumeToken: 'cp-other' } });
  const result = resumeThroughMcp({ approvalAuthorityMode: SERVICE, authorityApprovalId: other.approvalId,
    authorityDecision: other.envelope, authorityConsumption: other.consumption });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTHORITY_DECISION_INVALID');
});
