'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { callTool } = require('../mcpServer');
const { TOOL_SCHEMAS } = require('../lib/mcp-tool-catalog');

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
      if (!saved || saved.id !== id || saved.status !== 'pending') {
        return { claimed: false, approval: saved && structuredClone(saved) };
      }
      saved = { ...saved, status: 'executing', updatedAt: Date.now(), reason };
      return { claimed: true, approval: structuredClone(saved) };
    },
    finalizeToolApprovalWithReceipt(id, {
      expectedStatus = 'executing', decision = 'approved', reason = '', receipt = null, contextPatch = null,
    } = {}) {
      if (!saved || saved.id !== id || saved.status !== expectedStatus || !receipt) {
        return { finalized: false, approval: saved && structuredClone(saved) };
      }
      saved = {
        ...saved,
        status: decision === 'approved' ? 'approved' : 'rejected',
        decision,
        reason,
        updatedAt: Date.now(),
        context: {
          ...(saved.context || {}),
          ...(contextPatch || {}),
          receipt,
        },
      };
      return { finalized: true, approval: structuredClone(saved) };
    },
    rejectToolApproval() {
      return { rejected: false, approval: saved && structuredClone(saved) };
    },
    failToolApproval(id, reason) {
      saved = { ...saved, status: 'failed', reason, updatedAt: Date.now() };
      return { approval: structuredClone(saved) };
    },
    get saved() {
      return saved && structuredClone(saved);
    },
  };
}

function kernelStub() {
  return {
    graph: { runMutationOnce: () => ({ executed: true }) },
    learn(text, options) {
      const receipt = {
        receiptId: 'rcpt_candidate_1',
        candidateId: options.candidateId,
        memoryDraftId: options.memoryDraftId,
        provenanceId: options.provenanceId,
        workspaceId: options.workspaceId,
        approvalId: options.approvalId,
      };
      return {
        ok: true,
        type: 'learn',
        data: {
          learned: 1,
          text,
          admission: {
            candidateId: options.candidateId,
            memoryDraftId: options.memoryDraftId,
            provenanceId: options.provenanceId,
            workspaceId: options.workspaceId,
            approvalId: options.approvalId,
            status: 'approved',
          },
          receipt,
        },
        evidence: [],
        error: null,
        meta: {},
      };
    },
  };
}

describe('huqan.learn candidate/admission contract (#787)', () => {
  it('queues a durable candidate with provenance and workspace scope without canonical write', () => {
    const store = approvalStore();
    const result = callTool(kernelStub(), {
      name: 'huqan.learn',
      arguments: JSON.stringify({
        text: 'React Native üretim için uygundur.',
        workspaceId: 'workspace-p0',
        provenance: {
          sourceRef: 'note://p0/1',
          sourceTitle: 'P0 design note',
          sourceType: 'manual',
          sourceSubType: 'design-note',
          confidence: 0.82,
        },
      }),
    }, { approvalStore: store });

    assert.equal(result.ok, false);
    assert.equal(result.gate.decision, 'review');
    assert.equal(result.approval.persisted, true);
    assert.equal(result.approval.context.queuedForExecution, true);
    assert.equal(result.approval.context.reviewRequired, true);
    assert.match(result.approval.context.candidateId, /^cand_/);
    assert.equal(result.approval.context.memoryDraftId, result.approval.context.candidateId);
    assert.equal(result.approval.context.workspaceId, 'workspace-p0');
    assert.equal(result.approval.context.candidate.status, 'pending');
    assert.equal(result.approval.context.provenance.sourceRef, 'note://p0/1');
    assert.equal(result.approval.context.provenance.sourceType, 'manual');
    assert.equal(result.approval.context.provenance.workspaceId, 'workspace-p0');
    assert.equal(store.saved.context.candidateId, result.approval.context.candidateId);
  });

  it('keeps the same candidate, provenance and workspace through approve to final receipt', () => {
    const store = approvalStore();
    const kernel = kernelStub();
    const queued = callTool(kernel, {
      name: 'huqan.learn',
      arguments: JSON.stringify({
        text: 'A candidate requiring review.',
        workspaceId: 'workspace-p0',
        provenance: { sourceRef: 'source://p0/2', sourceType: 'manual', confidence: 0.7 },
      }),
    }, { approvalStore: store });
    const approvalId = queued.approval.id;
    const expected = queued.approval.context;

    const approved = callTool(kernel, {
      name: 'huqan.approve',
      operatorToken: 'operator-token',
      arguments: JSON.stringify({ approvalId, workspaceId: 'workspace-p0', decision: 'approved' }),
    }, { approvalStore: store, operatorToken: 'operator-token' });

    assert.equal(approved.ok, true);
    assert.equal(approved.data.executed, true);
    assert.equal(approved.data.approval.status, 'approved');
    assert.equal(approved.data.approval.context.candidateId, expected.candidateId);
    assert.equal(approved.data.approval.context.memoryDraftId, expected.memoryDraftId);
    assert.equal(approved.data.approval.context.workspaceId, expected.workspaceId);
    assert.equal(approved.data.approval.context.provenance.provenanceId, expected.provenance.provenanceId);
    assert.equal(approved.data.receipt.receiptId, 'rcpt_candidate_1');
    assert.equal(approved.data.receipt.candidateId, expected.candidateId);
    assert.equal(approved.data.receipt.memoryDraftId, expected.memoryDraftId);
    assert.equal(approved.data.receipt.workspaceId, expected.workspaceId);
    assert.equal(approved.data.receipt.provenanceId, expected.provenance.provenanceId);
  });

  it('publishes the new learn input fields in the MCP catalog', () => {
    const tool = TOOL_SCHEMAS.find(entry => entry.name === 'huqan.learn');
    assert.ok(tool);
    assert.equal(tool.inputSchema.properties.workspaceId.type, 'string');
    assert.equal(tool.inputSchema.properties.provenance.type, 'object');
    assert.equal(tool.inputSchema.properties.provenance.additionalProperties, false);
  });
});

module.exports = {};
