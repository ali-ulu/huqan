'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = require('../cli');
const { createKernel } = require('../lib/kernel-factory');
const { callTool } = require('../mcpServer');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { snapshotAgentIdentityAuthority } = require('../lib/agent-identity-runtime');

function identityRecord(ownerActorId = 'cli-receiver-owner') {
  return {
    agent_id: 'agent-cli-001',
    agent_type: 'local',
    display_name: 'CLI Approval Agent',
    owner_actor_id: ownerActorId,
    workspace_id: 'default',
    delegation_scope: ['learn'],
    allowed_tools: ['huqan.learn'],
    allowed_memory_scopes: ['read_write_context'],
    allowed_connectors: ['mcp:huqan.learn'],
    risk_tier: 'low',
    trust_tier: 'probationary',
    policy_version: 'cli-identity-v1',
    issued_at: '2026-08-19T00:00:00.000Z',
    expires_at: '2027-08-19T00:00:00.000Z',
    revoked_at: null,
    revocation_reason: null,
    parent_agent_id: null,
    delegation_chain: [],
    receipt_refs: ['receipt-cli-001'],
    provenance_refs: ['provenance-cli-001'],
    audit_requirements: ['trust_receipt'],
    verification_status: 'registered',
    expected_status: 'valid',
    expected_reason_code: null,
  };
}

function buildRuntime(graph, { ownerActorId = 'cli-receiver-owner' } = {}) {
  const ledger = createTrustEvidenceLedger({ graph });
  const clock = () => Date.parse('2026-08-19T10:00:00.000Z');
  const oversight = createHumanOversightApprovalRuntime({
    graph,
    ledger,
    clock,
    resolveIdentity: ({ role, context, action }) => ({
      decision: 'allow',
      identity: {
        identityRef: context?.identityRef || (role === 'requester' ? 'agent:cli-worker' : 'human:cli-operator'),
        identityHash: context?.identityHash || (role === 'requester' ? 'hash-cli-worker' : 'hash-cli-operator'),
        workspaceId: action.workspaceId,
        agentId: role === 'requester' ? 'agent-cli-001' : '',
        ownerActorId: role === 'requester' ? 'cli-receiver-owner' : context?.identityRef || 'cli-operator',
        authorityRef: 'authority:workspace-default',
      },
    }),
    firewallEvaluator: () => ({ decision: 'allow', metadata: { firewallVersion: 'AAFW-v1.0.0' } }),
  });
  const authority = snapshotAgentIdentityAuthority({
    workspaceId: 'default',
    identities: [{ ref: 'identity:cli-001', record: identityRecord(ownerActorId) }],
    clock,
  });
  const agentIdentityRuntime = {
    authority,
    identityRef: 'identity:cli-001',
    receiver: { subject: 'cli-receiver-owner', kind: 'cli-runtime', workspaceId: 'default' },
    action: {
      capability: 'learn',
      target: 'memory://cli-approval',
      riskTier: 'low',
      tool: null,
      connector: 'mcp:huqan.learn',
    },
  };
  return { oversight, agentIdentityRuntime };
}

function createCliFixture({ ownerActorId = 'cli-receiver-owner' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-940-942-cli-'));
  const kernel = createKernel({
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
    loadPlugins: false,
  });
  const runtime = buildRuntime(kernel.graph, { ownerActorId });
  const cli = new CLI({
    kernelInstance: kernel,
    mcpOperatorToken: 'cli-operator-token',
    humanOversightApprovalRuntime: runtime.oversight,
    agentIdentityRuntime: runtime.agentIdentityRuntime,
    humanOversightRequesterContext: {
      session: 'receiver-owned-cli-session',
      subject: 'cli-receiver-owner',
      kind: 'cli-runtime',
    },
    humanOversightApproverContext: {
      identityRef: 'human:cli-operator',
      identityHash: 'hash-cli-operator',
    },
  });
  return { dir, kernel, cli };
}

function queueParams(text = 'CLI Agent Identity bounded candidate.') {
  return {
    name: 'axiom.learn',
    arguments: JSON.stringify({ text, workspaceId: 'default' }),
  };
}

async function closeFixture(fixture) {
  try { fixture.cli?.approvalStore?.close?.(); } catch (_) {}
  try { fixture.cli?.agent?.storage?.close?.(); } catch (_) {}
  try { fixture.kernel?.graph?.close?.(); } catch (_) {}
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}

test('CLI opt-in Agent Identity and Human Oversight allow a receiver-bound approval', async () => {
  const fixture = createCliFixture();
  let executions = 0;
  const originalLearn = fixture.kernel.learn.bind(fixture.kernel);
  fixture.kernel.learn = (...args) => {
    executions += 1;
    return originalLearn(...args);
  };
  try {
    const queued = callTool(fixture.kernel, queueParams(), fixture.cli._approvalRuntime());
    assert.equal(queued.ok, false);
    assert.equal(queued.approval.context.oversightRequired, true);

    const output = [];
    const firstResult = await CLI.runCliArgv(['onayla', queued.approval.id, '--json'], {
      cli: fixture.cli,
      stdout: value => output.push(value),
    });
    const firstDecision = JSON.parse(output[0]);

    assert.equal(firstResult.exitCode, 8, JSON.stringify(firstDecision));
    assert.equal(firstDecision.ok, false, JSON.stringify(firstDecision));
    assert.equal(firstDecision.error.code, 'OVERSIGHT_QUORUM_PENDING');
    assert.equal(fixture.cli.approvalStore.getToolApprovalById(queued.approval.id).status, 'pending');
    assert.equal(executions, 0);

    const approvalArguments = { approvalId: queued.approval.id, workspaceId: 'default', decision: 'approved' };
    const decision = await callTool(fixture.kernel, {
      name: 'huqan.approve',
      operatorCapability: fixture.cli._createOperatorCapability('huqan.approve', approvalArguments),
      arguments: JSON.stringify(approvalArguments),
    }, {
      ...fixture.cli._approvalRuntime(),
      humanOversightApproverContext: { identityRef: 'human:cli-operator-b', identityHash: 'hash-cli-operator-b' },
    });

    assert.equal(decision.ok, true, JSON.stringify(decision));
    assert.equal(decision.data.executed, true);
    assert.equal(decision.data.identity.decision, 'allow');
    assert.equal(decision.data.identity.identity.identityRef, 'identity:cli-001');
    assert.ok(decision.data.oversight.caseId);
    assert.equal(Object.hasOwn(decision.data.identity, 'claim'), false);
    assert.equal(executions, 1);
  } finally {
    await closeFixture(fixture);
  }
});

test('CLI receiver identity mismatch fails closed before approval claim and execution', async () => {
  const fixture = createCliFixture({ ownerActorId: 'different-owner' });
  let executions = 0;
  const originalLearn = fixture.kernel.learn.bind(fixture.kernel);
  fixture.kernel.learn = (...args) => {
    executions += 1;
    return originalLearn(...args);
  };
  try {
    const queued = callTool(fixture.kernel, queueParams('CLI identity mismatch candidate.'), fixture.cli._approvalRuntime());
    assert.equal(queued.ok, false);
    assert.equal(queued.approval.context.oversightRequired, true);

    const output = [];
    const result = await CLI.runCliArgv(['onayla', queued.approval.id, '--json'], {
      cli: fixture.cli,
      stdout: value => output.push(value),
    });
    const blocked = JSON.parse(output[0]);
    const current = fixture.cli.approvalStore.getToolApprovalById(queued.approval.id);

    assert.equal(result.exitCode, 8, JSON.stringify(blocked));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
    assert.equal(blocked.meta.identity.allowed, false);
    assert.equal(current.status, 'pending');
    assert.equal(executions, 0);
  } finally {
    await closeFixture(fixture);
  }
});
