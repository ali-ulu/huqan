'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { callTool, createServer } = require('../mcpServer');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');

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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-942-mcp-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const ledger = createTrustEvidenceLedger({ graph });
  const clockState = { now: Date.parse('2026-08-19T10:00:00.000Z') };
  const runtime = createHumanOversightApprovalRuntime({
    graph,
    ledger,
    clock: () => clockState.now,
    humanOversightRequesterContext: undefined,
    resolveIdentity: ({ role, context, action }) => ({
      decision: context?.deny ? 'block' : 'allow',
      identity: {
        identityRef: context?.identityRef || (role === 'requester' ? 'agent:worker-a' : 'human:operator-a'),
        identityHash: context?.identityHash || (role === 'requester' ? 'hash-worker-a' : 'hash-operator-a'),
        workspaceId: action.workspaceId,
        agentId: role === 'requester' ? 'agent-a' : '',
        ownerActorId: role === 'requester' ? 'owner-a' : context?.identityRef || 'operator-a',
        authorityRef: 'authority:workspace-a',
      },
    }),
    firewallEvaluator: () => ({ decision: 'allow', metadata: { firewallVersion: 'AAFW-v1.0.0' } }),
  });
  const kernel = {
    graph,
    learn(text, options) {
      return {
        ok: true,
        type: 'learn',
        data: {
          learned: 1,
          text,
          receipt: {
            receiptId: 'mcp-oversight-learn-receipt',
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
  return { dir, graph, runtime, kernel, store: approvalStore(), clockState };
}

function queueParams() {
  return {
    name: 'huqan.learn',
    arguments: JSON.stringify({
      text: 'MCP Human Oversight bounded candidate.',
      workspaceId: 'workspace-a',
      provenance: { sourceRef: 'source://oversight/1', sourceType: 'manual', confidence: 0.8 },
    }),
  };
}

function runtimeOptions(fixture) {
  return {
    approvalStore: fixture.store,
    operatorToken: 'operator-token',
    humanOversightApprovalRuntime: fixture.runtime,
    humanOversightRequesterContext: { session: 'receiver-owned-mcp-session' },
    humanOversightApproverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
  };
}

test('MCP opt-in approval path creates and executes a durable Human Oversight case', async () => {
  const f = fixture();
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    assert.equal(queued.ok, false);
    assert.equal(queued.approval.persisted, true);
    assert.equal(queued.approval.context.oversightRequired, true);
    assert.match(queued.approval.oversight.caseId, /^mcp-oversight:/);
    const pending = f.runtime.getReviewCase(queued.approval.oversight.caseId);
    assert.equal(pending.ok, true);
    assert.equal(pending.case.status, 'pending');

    const approved = await callTool(f.kernel, {
      name: 'huqan.approve',
      operatorToken: 'operator-token',
      arguments: JSON.stringify({ approvalId: queued.approval.id, decision: 'approved', reason: 'bounded_operator_review' }),
    }, runtimeOptions(f));
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.data.executed, true);
    assert.equal(approved.data.oversight.status, 'executed');
    assert.equal(approved.data.oversight.decisionType, 'approve');
    assert.ok(approved.data.oversight.executionReceiptId);
    assert.equal(f.runtime.getReviewCase(queued.approval.oversight.caseId).case.status, 'executed');
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('MCP createServer propagates opt-in Human Oversight runtime without changing default queue semantics', () => {
  const f = fixture();
  try {
    const server = createServer({
      kernel: f.kernel,
      approvalStore: f.store,
      operatorToken: 'operator-token',
      humanOversightApprovalRuntime: f.runtime,
      humanOversightRequesterContext: { session: 'receiver-owned-mcp-session' },
      humanOversightApproverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
    });
    const response = server.handleRequest({ id: 'queue-1', method: 'tools/call', params: queueParams() });
    assert.equal(response.result.structuredContent.ok, false);
    assert.equal(response.result.structuredContent.approval.context.oversightRequired, true);
    assert.match(response.result.structuredContent.approval.oversight.caseId, /^mcp-oversight:/);
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('MCP oversight marker fails closed when the runtime is absent at approval time', () => {
  const f = fixture();
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    const result = callTool(f.kernel, {
      name: 'huqan.approve',
      operatorToken: 'operator-token',
      arguments: JSON.stringify({ approvalId: queued.approval.id, decision: 'approved' }),
    }, { approvalStore: f.store, operatorToken: 'operator-token' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'OVERSIGHT_RUNTIME_UNAVAILABLE');
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
