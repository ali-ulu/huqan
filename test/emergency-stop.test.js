'use strict';

// Emergency stop (#2505 F): the durable ledger, and the enforcement points
// that read it -- the external action guard's identity gate, MCP tool
// dispatch, the agent step executor and A2A exchange admission.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EMERGENCY_STOP_REASON,
  EMERGENCY_STOP_UNREADABLE_REASON,
  EMERGENCY_STOP_INTEGRITY_VIOLATION_REASON,
  createEmergencyStop,
} = require('../lib/emergency-stop');

function ledgerIn(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-emergency-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createEmergencyStop({ directory: dir, now: () => '2026-09-15T20:00:00.000Z' });
}

function receiptsOf(ledger) {
  const file = path.join(ledger.directory, 'receipts.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('stopping an agent stops only that agent in that workspace, and is receipted', (t) => {
  const ledger = ledgerIn(t);
  const result = ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'containment', actor: 'operator:ali' });
  assert.equal(result.created, true);
  assert.deepEqual(ledger.check({ workspaceId: 'w', agentId: 'a1' }), {
    stopped: true, scope: 'agent', reason: EMERGENCY_STOP_REASON, record: result.record,
  });
  assert.equal(ledger.check({ workspaceId: 'w', agentId: 'a2' }).stopped, false);
  assert.equal(ledger.check({ workspaceId: 'other', agentId: 'a1' }).stopped, false);
  assert.equal(ledger.check({ workspaceId: 'w' }).stopped, false, 'an agent stop does not stop the workspace');

  const receipts = receiptsOf(ledger);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].action, 'stop');
  assert.equal(receipts[0].actor, 'operator:ali');
  assert.match(receipts[0].receiptHash, /^[a-f0-9]{64}$/);
});

test('stopping a workspace stops every agent in it and the calls that name no agent', (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'w', reason: 'incident', actor: 'operator:ali' });
  assert.equal(ledger.check({ workspaceId: 'w' }).scope, 'workspace');
  assert.equal(ledger.check({ workspaceId: 'w', agentId: 'any-agent' }).scope, 'workspace');
  assert.equal(ledger.check({ workspaceId: 'other' }).stopped, false);
});

test('a second stop of the same scope keeps the first record and writes no second receipt', (t) => {
  const ledger = ledgerIn(t);
  const first = ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'first', actor: 'operator:ali' });
  const second = ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'second', actor: 'operator:bob' });
  assert.equal(second.created, false);
  assert.deepEqual(second.record, first.record);
  assert.equal(receiptsOf(ledger).length, 1);
});

test('lifting a stop reopens the scope and is receipted; lifting nothing records nothing', (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'containment', actor: 'operator:ali' });
  const lifted = ledger.lift({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'reviewed', actor: 'operator:ali' });
  assert.equal(lifted.lifted, true);
  assert.equal(ledger.check({ workspaceId: 'w', agentId: 'a1' }).stopped, false);
  assert.equal(ledger.lift({ scope: 'agent', workspaceId: 'w', agentId: 'a1', actor: 'operator:ali' }).lifted, false);
  assert.deepEqual(receiptsOf(ledger).map((receipt) => receipt.action), ['stop', 'lift']);
});

test('a stop record that cannot be read keeps the scope stopped', (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'containment', actor: 'operator:ali' });
  const [recordFile] = fs.readdirSync(ledger.directory).filter((name) => name.endsWith('.stop.json'));
  fs.writeFileSync(path.join(ledger.directory, recordFile), 'not json', 'utf8');
  // #2584: with ledger, a corrupt file is an integrity violation (still fail-closed, louder)
  const result = ledger.check({ workspaceId: 'w', agentId: 'a1' });
  assert.equal(result.stopped, true);
  assert.ok(
    result.reason === EMERGENCY_STOP_UNREADABLE_REASON || result.reason === EMERGENCY_STOP_INTEGRITY_VIOLATION_REASON,
    `expected unreadable or integrity violation, got ${result.reason}`,
  );
  assert.equal(result.record, null);
});

test('no directory means no stop has been issued', (t) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-emergency-stop-missing-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ledger = createEmergencyStop({ directory: path.join(base, 'never-created') });
  assert.equal(ledger.check({ workspaceId: 'w', agentId: 'a1' }).stopped, false);
});

test('a stop needs a known scope, an agent id for an agent stop, and the operator who issued it', (t) => {
  const ledger = ledgerIn(t);
  assert.throws(() => ledger.stop({ scope: 'galaxy', workspaceId: 'w', actor: 'operator:ali' }), /unknown emergency stop scope/);
  assert.throws(() => ledger.stop({ scope: 'agent', workspaceId: 'w', actor: 'operator:ali' }), /needs an agent id/);
  assert.throws(() => ledger.stop({ scope: 'workspace', workspaceId: 'w' }), /needs the operator/);
});

test('the external action guard blocks a stopped agent through its identity gate', (t) => {
  const { evaluateExternalAction } = require('../lib/external-action-guard');
  const ledger = ledgerIn(t);
  const input = {
    invocationId: 'stop-1', agentName: 'stopped-agent', sessionId: 's', turnId: 't',
    toolName: 'Read', action: 'read', args: { file_path: 'README.md' },
    cwd: process.cwd(), workspaceRoot: process.cwd(), workspaceId: 'default',
  };
  const options = {
    environment: {}, dataResidency: null, receiptWriter: { append() {} },
    graduatedAutonomy: { enabled: false }, emergencyStop: ledger,
  };
  const before = evaluateExternalAction(input, options);
  assert.notEqual(before.findings.find((entry) => entry.gate === 'identity').reason, EMERGENCY_STOP_REASON);

  ledger.stop({ scope: 'agent', workspaceId: 'default', agentId: 'stopped-agent', reason: 'test', actor: 'operator:test' });
  const after = evaluateExternalAction({ ...input, invocationId: 'stop-2' }, options);
  const identity = after.findings.find((entry) => entry.gate === 'identity');
  assert.equal(after.decision, 'block');
  assert.equal(identity.reason, EMERGENCY_STOP_REASON);
  assert.equal(identity.stopScope, 'agent');
});

test('an MCP tool call in a stopped workspace is refused, and operator tools are not', (t) => {
  const { createMcpToolDispatch } = require('../lib/mcp/tool-dispatch');
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'w-stop', reason: 'test', actor: 'operator:test' });
  const { callTool } = createMcpToolDispatch({ withTransientAgent: () => { throw new Error('no agent may run'); } });

  const refused = callTool({}, { name: 'huqan.ask', arguments: JSON.stringify({ query: 'x', workspaceId: 'w-stop' }) }, { emergencyStop: ledger });
  assert.match(JSON.stringify(refused), /EMERGENCY_STOPPED/);

  const operator = callTool({}, { name: 'huqan.approve', arguments: JSON.stringify({ approvalId: 'a1', workspaceId: 'w-stop' }) }, { emergencyStop: ledger });
  assert.doesNotMatch(JSON.stringify(operator), /EMERGENCY_STOPPED/, 'operator tools stay reachable during a stop');
});

test('an authorized operator read in a stopped workspace reaches its handler, not the stop', (t) => {
  // An unauthorized operator call is refused before the stop is consulted, so
  // the exemption itself is only exercised by a call that passes authorization.
  const { createMcpToolDispatch } = require('../lib/mcp/tool-dispatch');
  const { createMcpOperatorCapability } = require('../lib/mcp-operator-capability');
  const { operatorCapabilityBinding } = require('../lib/mcp/operator-authorization');
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'w-stop', reason: 'test', actor: 'operator:test' });
  const { callTool } = createMcpToolDispatch({ withTransientAgent: () => { throw new Error('no agent may run'); } });

  const args = { limit: 2, workspaceId: 'w-stop' };
  const params = {
    name: 'huqan.approvals',
    arguments: JSON.stringify(args),
    operatorCapability: createMcpOperatorCapability({ secret: 'stop-operator', ...operatorCapabilityBinding('huqan.approvals', args) }),
  };
  const runtime = {
    emergencyStop: ledger,
    operatorSecret: 'stop-operator',
    operatorCapabilityNonces: new Map(),
    approvalStore: {
      listUnresolvedToolApprovals: () => [],
      countPendingToolApprovals: () => 0,
      countUnresolvedToolApprovals: () => 0,
    },
  };
  let outcome;
  try {
    outcome = callTool({ plugins: { emit: () => {} } }, params, runtime);
  } catch (error) {
    outcome = { thrown: String(error && error.message) };
  }
  const text = JSON.stringify(outcome);
  assert.doesNotMatch(text, /EMERGENCY_STOPPED/, 'an authorized operator tool is exempt from the workspace stop');
  assert.doesNotMatch(text, /OPERATOR_AUTH_REQUIRED/, 'the call must pass authorization for this test to mean anything');
});

test('a stopped agent runs no further step', (t) => {
  const { executeAgentStep } = require('../lib/agent-step-executor');
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'runner', reason: 'test', actor: 'operator:test' });
  const report = executeAgentStep({
    step: { id: 's1', action: 'ask', tool: 'ask', input: 'x' },
    state: { workspaceId: 'w', agentId: 'runner' },
    opts: { emergencyStop: ledger },
    runtime: { kernel: {}, allowedTools: new Set(['ask']), emit() { throw new Error('no plugin may run'); } },
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.result.error.code, 'AGENT_EMERGENCY_STOPPED');
  assert.equal(report.result.meta.emergencyStop.scope, 'agent');
});

test('an A2A exchange naming a stopped agent is refused', (t) => {
  const { buildFixture } = require('../scripts/a2a-conformance/run');
  const { evaluateInterAgentReceiptAdmission } = require('../lib/a2a/inter-agent-receipt-chain');
  const ledger = ledgerIn(t);
  const fixture = buildFixture();
  const receiver = { decision: 'allow', reason: 'receiver_allow', risk: { score: 0.05 }, metadata: { firewallVersion: 'test' } };
  assert.equal(evaluateInterAgentReceiptAdmission(fixture.request, receiver, { emergencyStop: ledger }).decision, receiver);

  for (const agentId of [fixture.request.source.agentId, fixture.request.target.agentId]) {
    ledger.stop({ scope: 'agent', workspaceId: fixture.request.workspaceId, agentId, reason: 'test', actor: 'operator:test' });
    const refused = evaluateInterAgentReceiptAdmission(fixture.request, receiver, { emergencyStop: ledger });
    assert.equal(refused.decision.decision, 'block');
    assert.equal(refused.decision.reason, 'AGENT_EMERGENCY_STOPPED');
    ledger.lift({ scope: 'agent', workspaceId: fixture.request.workspaceId, agentId, actor: 'operator:test' });
  }
});

function ledgerEntriesOf(ledger) {
  const file = path.join(ledger.directory, 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('stop and lift carry an operator identity claim on the record, ledger entry and receipt (#2601)', (t) => {
  const ledger = ledgerIn(t);
  const stopped = ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'containment', actor: 'operator:cli', operatorIdentity: 'human:alice' });
  assert.equal(stopped.record.operatorIdentity, 'human:alice');
  assert.equal(stopped.record.actor, 'operator:cli');
  assert.equal(stopped.receipt.operatorIdentity, 'human:alice');
  assert.equal(stopped.ledgerEntry.operatorIdentity, 'human:alice');
  const lifted = ledger.lift({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'reviewed', actor: 'operator:cli', operatorIdentity: 'human:alice' });
  assert.equal(lifted.receipt.operatorIdentity, 'human:alice');
  assert.equal(ledger.check({ workspaceId: 'w', agentId: 'a1' }).record, null, 'lift clears the replayed record');
  const restopped = ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'again', actor: 'operator:cli', operatorIdentity: 'human:bob' });
  assert.equal(restopped.created, true);
  const replayed = ledger.check({ workspaceId: 'w', agentId: 'a1' });
  assert.equal(replayed.record.operatorIdentity, 'human:bob', 'replay carries the author identity for the future quorum rule');
  const entries = ledgerEntriesOf(ledger);
  assert.deepEqual(entries.map((entry) => [entry.action, entry.operatorIdentity]), [['stop', 'human:alice'], ['lift', 'human:alice'], ['stop', 'human:bob']]);
});

test('absent operator identity reads as null everywhere, never as the role actor (#2601)', (t) => {
  const ledger = ledgerIn(t);
  const stopped = ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'containment', actor: 'operator:cli' });
  assert.equal(stopped.record.operatorIdentity, null);
  assert.equal(stopped.receipt.operatorIdentity, null);
  assert.equal(stopped.ledgerEntry.operatorIdentity, null);
});

test('operator argument shapes default to the default workspace (#2505 F-2b)', () => {
  const { checkArguments, changeArguments } = require('../lib/emergency-stop');
  assert.deepEqual(checkArguments({}), { workspaceId: 'default', agentId: '' });
  assert.deepEqual(checkArguments({ workspaceId: '  w1 ' }), { workspaceId: 'w1', agentId: '' });
  assert.deepEqual(changeArguments({ action: 'stop', scope: 'workspace' }), { action: 'stop', scope: 'workspace', workspaceId: 'default', agentId: '', reason: '' });
  assert.equal(changeArguments({ action: 'stop', scope: 'workspace', workspaceId: '', reason: '  halt ' }).reason, 'halt');
});



test('an emergency stop survives ledger restart', (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-emergency-stop-restart-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = createEmergencyStop({ directory, now: () => '2026-09-28T20:00:00.000Z' });
  first.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'restart-proof', actor: 'operator:test' });

  const restarted = createEmergencyStop({ directory, now: () => '2026-09-28T20:01:00.000Z' });
  const status = restarted.check({ workspaceId: 'w', agentId: 'a1' });
  assert.equal(status.stopped, true);
  assert.equal(status.record.reason, 'restart-proof');
});
