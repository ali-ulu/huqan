'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { callTool, createServer } = require('../mcpServer');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const {
  snapshotAgentIdentityAuthority,
} = require('../lib/agent-identity-runtime');

function approvalStore() {
  let saved = null;
  return {
    saveToolApproval(record) {
      saved = structuredClone(record);
      return saved;
    },
    getToolApprovalById(id) {
      return saved && saved.id === id ? structuredClone(saved) : null;
    },
    claimToolApproval(id, reason) {
      if (!saved || saved.id !== id || saved.status !== 'pending') return { claimed: false, approval: saved && structuredClone(saved) };
      saved = { ...saved, status: 'executing', updatedAt: Date.now(), reason };
      return { claimed: true, approval: structuredClone(saved) };
    },
    finalizeToolApprovalWithReceipt(id, { expectedStatus = 'executing', decision = 'approved', reason = '', receipt = null, contextPatch = null } = {}) {
      if (!saved || saved.id !== id || saved.status !== expectedStatus || !receipt) return { finalized: false, approval: saved && structuredClone(saved) };
      saved = {
        ...saved,
        status: decision === 'approved' ? 'approved' : 'rejected',
        decision,
        reason,
        updatedAt: Date.now(),
        context: { ...(saved.context || {}), ...(contextPatch || {}), receipt },
      };
      return { finalized: true, approval: structuredClone(saved) };
    },
    rejectToolApproval(id, reason) {
      if (!saved || saved.id !== id || saved.status !== 'pending') return { rejected: false, approval: saved && structuredClone(saved) };
      saved = { ...saved, status: 'rejected', decision: 'rejected', reason, updatedAt: Date.now() };
      return { rejected: true, approval: structuredClone(saved) };
    },
    failToolApproval(id, reason) {
      saved = { ...saved, status: 'failed', reason, updatedAt: Date.now() };
      return { approval: structuredClone(saved) };
    },
  };
}

function identityRecord({ ownerActorId = 'mcp-receiver-owner' } = {}) {
  return {
    agent_id: 'agent-mcp-001',
    agent_type: 'local',
    display_name: 'MCP Approval Agent',
    owner_actor_id: ownerActorId,
    workspace_id: 'workspace-mcp',
    delegation_scope: ['learn'],
    allowed_tools: ['huqan.learn'],
    allowed_memory_scopes: ['read_write_context'],
    allowed_connectors: ['mcp:huqan.learn'],
    risk_tier: 'low',
    trust_tier: 'probationary',
    policy_version: 'mcp-identity-v1',
    issued_at: '2026-08-19T00:00:00.000Z',
    expires_at: '2027-08-19T00:00:00.000Z',
    revoked_at: null,
    revocation_reason: null,
    parent_agent_id: null,
    delegation_chain: [],
    receipt_refs: ['receipt-mcp-001'],
    provenance_refs: ['provenance-mcp-001'],
    audit_requirements: ['trust_receipt'],
    verification_status: 'registered',
    expected_status: 'valid',
    expected_reason_code: null,
  };
}

function fixture({ ownerActorId = 'mcp-receiver-owner' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-940-mcp-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const ledger = createTrustEvidenceLedger({ graph });
  let executions = 0;
  const clock = () => Date.parse('2026-08-19T10:00:00.000Z');
  const oversight = createHumanOversightApprovalRuntime({
    graph,
    ledger,
    clock,
    humanOversightRequesterContext: undefined,
    resolveIdentity: ({ role, context, action }) => ({
      decision: 'allow',
      identity: {
        identityRef: context?.identityRef || (role === 'requester' ? 'agent:worker-a' : 'human:operator-a'),
        identityHash: context?.identityHash || (role === 'requester' ? 'hash-worker-a' : 'hash-operator-a'),
        workspaceId: action.workspaceId,
        agentId: role === 'requester' ? 'agent-a' : '',
        ownerActorId: role === 'requester' ? 'owner-a' : context?.identityRef || 'operator-a',
        authorityRef: 'authority:workspace-mcp',
      },
    }),
    firewallEvaluator: () => ({ decision: 'allow', metadata: { firewallVersion: 'AAFW-v1.0.0' } }),
  });
  const record = identityRecord({ ownerActorId });
  const authority = snapshotAgentIdentityAuthority({
    workspaceId: 'workspace-mcp',
    identities: [{ ref: 'identity:mcp-001', record }],
    clock,
  });
  const agentIdentityRuntime = {
    authority,
    identityRef: 'identity:mcp-001',
    receiver: { subject: 'mcp-receiver-owner', kind: 'mcp-server', workspaceId: 'workspace-mcp' },
    action: {
      capability: 'learn',
      target: 'memory://mcp-approval',
      riskTier: 'low',
      tool: null,
      connector: 'mcp:huqan.learn',
    },
  };
  const kernel = {
    graph,
    learn(text, options) {
      executions += 1;
      return {
        ok: true,
        type: 'learn',
        data: {
          learned: 1,
          text,
          receipt: {
            receiptId: 'mcp-identity-learn-receipt',
            candidateId: options.candidateId,
            memoryDraftId: options.memoryDraftId,
            provenanceId: options.provenanceId,
            workspaceId: options.workspaceId,
            approvalId: options.approvalId,
          },
        },
        evidence: [],
        error: null,
        meta: {},
      };
    },
  };
  return {
    dir,
    graph,
    kernel,
    store: approvalStore(),
    oversight,
    agentIdentityRuntime,
    get executions() { return executions; },
  };
}

function queueParams() {
  return {
    name: 'huqan.learn',
    arguments: JSON.stringify({
      text: 'MCP Agent Identity bounded candidate.',
      workspaceId: 'workspace-mcp',
      provenance: { sourceRef: 'source://identity/1', sourceType: 'manual', confidence: 0.8 },
    }),
  };
}

function runtimeOptions(fixture) {
  return {
    approvalStore: fixture.store,
    operatorToken: 'operator-token',
    humanOversightApprovalRuntime: fixture.oversight,
    humanOversightRequesterContext: {
      session: 'receiver-owned-mcp-session',
      subject: 'mcp-receiver-owner',
      kind: 'mcp-server',
    },
    humanOversightApproverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
    agentIdentityRuntime: fixture.agentIdentityRuntime,
  };
}

test('MCP approval executes when receiver-owned Agent Identity allows the action', async () => {
  const f = fixture();
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    assert.equal(queued.ok, false);
    assert.equal(queued.approval.context.oversightRequired, true);

    const first = await callTool(f.kernel, {
      name: 'huqan.approve',
      operatorToken: 'operator-token',
      arguments: JSON.stringify({ approvalId: queued.approval.id, workspaceId: 'workspace-mcp', decision: 'approved' }),
    }, runtimeOptions(f));
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.error.code, 'OVERSIGHT_QUORUM_PENDING');
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');
    assert.equal(f.executions, 0);

    const approved = await callTool(f.kernel, {
      name: 'huqan.approve',
      operatorToken: 'operator-token',
      arguments: JSON.stringify({ approvalId: queued.approval.id, workspaceId: 'workspace-mcp', decision: 'approved' }),
    }, {
      ...runtimeOptions(f),
      humanOversightApproverContext: { identityRef: 'human:operator-b', identityHash: 'hash-operator-b' },
    });

    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.data.executed, true);
    assert.equal(approved.data.identity.decision, 'allow');
    assert.equal(approved.data.identity.identity.identityRef, 'identity:mcp-001');
    assert.equal(approved.data.identity.identity.workspaceId, 'workspace-mcp');
    assert.equal(Object.hasOwn(approved.data.identity, 'claim'), false);
    assert.equal(f.executions, 1);
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('MCP createServer propagates opt-in Agent Identity runtime into approval execution', async () => {
  const f = fixture();
  try {
    const serverOptions = (approverContext) => ({
      kernel: f.kernel,
      approvalStore: f.store,
      operatorToken: 'operator-token',
      humanOversightApprovalRuntime: f.oversight,
      humanOversightRequesterContext: {
        session: 'receiver-owned-mcp-session',
        subject: 'mcp-receiver-owner',
        kind: 'mcp-server',
      },
      humanOversightApproverContext: approverContext,
      agentIdentityRuntime: f.agentIdentityRuntime,
    });
    const server = createServer(serverOptions({ identityRef: 'human:operator-a', identityHash: 'hash-operator-a' }));
    const queuedResponse = server.handleRequest({ id: 'queue-identity-1', method: 'tools/call', params: queueParams() });
    const queued = queuedResponse.result.structuredContent;
    const firstResponse = await server.handleRequest({
      id: 'approve-identity-1',
      method: 'tools/call',
      params: {
        name: 'huqan.approve',
        operatorToken: 'operator-token',
        arguments: JSON.stringify({ approvalId: queued.approval.id, workspaceId: 'workspace-mcp', decision: 'approved' }),
      },
    });
    const first = firstResponse.result.structuredContent;
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.error.code, 'OVERSIGHT_QUORUM_PENDING');
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');

    const secondServer = createServer(serverOptions({ identityRef: 'human:operator-b', identityHash: 'hash-operator-b' }));
    const approvedResponse = await secondServer.handleRequest({
      id: 'approve-identity-2',
      method: 'tools/call',
      params: {
        name: 'huqan.approve',
        operatorToken: 'operator-token',
        arguments: JSON.stringify({ approvalId: queued.approval.id, workspaceId: 'workspace-mcp', decision: 'approved' }),
      },
    });
    const approved = approvedResponse.result.structuredContent;
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.data.identity.decision, 'allow');
    assert.equal(f.executions, 1);
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('MCP approval fails closed before claim and executor when receiver-owned identity binding mismatches', async () => {
  const f = fixture({ ownerActorId: 'different-owner' });
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    const blocked = await callTool(f.kernel, {
      name: 'huqan.approve',
      operatorToken: 'operator-token',
      arguments: JSON.stringify({ approvalId: queued.approval.id, workspaceId: 'workspace-mcp', decision: 'approved' }),
    }, runtimeOptions(f));

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
    assert.equal(blocked.meta.identity.allowed, false);
    assert.equal(blocked.meta.identity.reason, 'identity.unknown');
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');
    assert.equal(f.executions, 0);
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
