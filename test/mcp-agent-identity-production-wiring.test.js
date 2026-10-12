'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { callTool, createServer } = require('../mcpServer');
const {
  fixture,
  queueParams,
  operatorParams,
  runtimeOptions,
} = require('./helpers/mcp-identity-approval-fixture');

test('MCP approval executes when receiver-owned Agent Identity allows the action', async () => {
  const f = fixture();
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    assert.equal(queued.ok, false);
    assert.equal(queued.approval.context.oversightRequired, true);

    const first = await callTool(f.kernel, operatorParams('huqan.approve', {
      approvalId: queued.approval.id,
      workspaceId: 'workspace-mcp',
      decision: 'approved',
    }), runtimeOptions(f));
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.error.code, 'OVERSIGHT_QUORUM_PENDING');
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');
    assert.equal(f.executions, 0);

    const approved = await callTool(f.kernel, operatorParams('huqan.approve', {
      approvalId: queued.approval.id,
      workspaceId: 'workspace-mcp',
      decision: 'approved',
    }), {
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
      params: operatorParams('huqan.approve', {
        approvalId: queued.approval.id,
        workspaceId: 'workspace-mcp',
        decision: 'approved',
      }),
    });
    const first = firstResponse.result.structuredContent;
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.error.code, 'OVERSIGHT_QUORUM_PENDING');
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');

    const secondServer = createServer(serverOptions({ identityRef: 'human:operator-b', identityHash: 'hash-operator-b' }));
    const approvedResponse = await secondServer.handleRequest({
      id: 'approve-identity-2',
      method: 'tools/call',
      params: operatorParams('huqan.approve', {
        approvalId: queued.approval.id,
        workspaceId: 'workspace-mcp',
        decision: 'approved',
      }),
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
    const blocked = await callTool(f.kernel, operatorParams('huqan.approve', {
      approvalId: queued.approval.id,
      workspaceId: 'workspace-mcp',
      decision: 'approved',
    }), runtimeOptions(f));

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
