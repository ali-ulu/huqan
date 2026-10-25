'use strict';

// #4240 (CWE-345): approval authority signed a narrower action than the one
// that executed.
//
// The MCP ingest approval stored `context.args` as the output of the generic
// `sanitizeToolArgsForStorage`, which drops array-valued fields and truncates
// every string at MCP_MAX_TEXT. The executed payload is `snapshot.payload`,
// built by `buildCapabilityPayload`, which keeps `alternatives`/`links` and the
// full `rationale`. So the reviewer approved a projection while the runtime ran
// a wider action, and the row carried no binding tying the two together.
//
// The row now stores the executed payload as `context.args` and binds it with
// `reviewedBinding`, so the decision-time check in
// lib/mcp-approval-decision-handler.js catches a post-review edit.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  callTool,
  createMcpOperatorCapability,
  operatorCapabilityBinding,
} = require('../mcpServer');
const { verifyIngestApprovalSnapshot } = require('../lib/ingest');

function decisionArgs(overrides = {}) {
  return {
    sourceType: 'decision',
    workspaceId: 'default',
    title: 'Karar',
    rationale: 'R'.repeat(900),
    decidedBy: 'ali',
    date: '2026-10-23',
    alternatives: ['A', 'B'],
    links: ['https://example.com/1', 'https://example.com/2'],
    ...overrides,
  };
}

function makeKernel() {
  return {
    ok: (op, data) => ({ ok: true, type: op, data, evidence: [], error: null, meta: {} }),
    fail: (op, code, message) => ({ ok: false, type: op, data: null, evidence: [], error: { code, message }, meta: {} }),
    runCapability: async () => ({
      ok: true,
      admission: {
        outcome: 'allow',
        graphWrite: true,
        entries: [{ workspaceId: 'default', receiptId: 'operation-receipt', auditId: 'operation-audit', graphWrite: true }],
      },
      evidence: [],
    }),
  };
}

function makeApprovalStore() {
  const records = new Map();
  return {
    records,
    saveToolApprovalIfAbsent(approval) {
      const existing = [...records.values()].find(item => item.approvalKey === approval.approvalKey);
      if (existing) return { inserted: false, approval: existing };
      records.set(approval.id, approval);
      return { inserted: true, approval };
    },
    getToolApprovalById(id) { return records.get(id) || null; },
    claimToolApproval() { return { claimed: false }; },
    rejectToolApproval() { return { rejected: false }; },
    claimToolApprovalWithLease(id) {
      const approval = records.get(id);
      if (!approval || approval.status !== 'pending') return { claimed: false, approval };
      approval.status = 'executing';
      approval.decision = 'approved';
      return { claimed: true, approval };
    },
    renewToolApprovalLease() { return { renewed: true }; },
    failToolApproval(id, reason) {
      const approval = records.get(id);
      if (approval) { approval.status = 'failed'; approval.reason = reason; }
      return { failed: Boolean(approval), approval };
    },
    finalizeToolApprovalWithReceipt(id, options) {
      const approval = records.get(id);
      if (!approval || approval.status !== options.expectedStatus) return { finalized: false, approval };
      approval.status = options.decision;
      approval.decision = options.decision;
      approval.reason = options.reason;
      approval.context = { ...approval.context, receipt: options.receipt };
      return { finalized: true, approval };
    },
  };
}

function queue(kernel, approvalStore, args) {
  return callTool(kernel, {
    name: 'huqan.ingest_execute',
    arguments: JSON.stringify(args),
  }, { approvalStore });
}

function approve(kernel, approvalStore, approvalId) {
  const args = { approvalId, decision: 'approved', workspaceId: 'default', reason: 'test_approved' };
  return callTool(kernel, {
    name: 'huqan.approve',
    arguments: JSON.stringify(args),
    operatorCapability: createMcpOperatorCapability({ secret: 'test-operator', ...operatorCapabilityBinding('huqan.approve', args) }),
  }, { approvalStore, operatorSecret: 'test-operator', operatorCapabilityNonces: new Map(), recordIngestApprovalAudit: () => ({ auditId: 'final-audit' }) });
}

describe('MCP ingest approval binds the reviewed args to the executed payload (#4240)', () => {
  it('shows the reviewer every field the execution will consume', () => {
    const kernel = makeKernel();
    const store = makeApprovalStore();
    const result = queue(kernel, store, decisionArgs());

    // The review gate refuses execution at queue time; the approval is still
    // persisted (see mcp-ingest-execute-contract.test.js).
    assert.equal(result.gate.decision, 'review');
    assert.equal(result.approval.persisted, true);
    const { args, snapshot } = result.approval.context;
    assert.deepEqual(args, snapshot.payload,
      'the reviewed args must be the payload that executes');
    assert.deepEqual(args.alternatives, ['A', 'B'],
      'array-valued fields must not be dropped from the reviewed action');
    assert.deepEqual(args.links, ['https://example.com/1', 'https://example.com/2']);
    assert.equal(args.rationale.length, 900, 'the full rationale must be reviewed, not truncated');
    assert.deepEqual(verifyIngestApprovalSnapshot(snapshot).ok, true);
  });

  it('binds the reviewed args so a post-review edit is refused', async () => {
    const kernel = makeKernel();
    const store = makeApprovalStore();
    const queued = queue(kernel, store, decisionArgs());
    const id = queued.approval.id;
    assert.ok(queued.approval.policy.reviewedBinding, 'the row must carry a reviewed binding');

    // The attacker widens the executed payload after review. This must fail
    // closed rather than run the wider action.
    const row = store.records.get(id);
    row.context = { ...row.context, args: { ...row.context.args, alternatives: ['A', 'B', 'C'] } };

    const approved = await approve(kernel, store, id);
    assert.equal(approved.ok, false);
    assert.equal(approved.error.code, 'APPROVAL_BINDING_MISMATCH');
  });

  it('binds the stored input too, so rewriting only that column is refused', async () => {
    const kernel = makeKernel();
    const store = makeApprovalStore();
    const queued = queue(kernel, store, decisionArgs());
    const id = queued.approval.id;

    const row = store.records.get(id);
    row.input = JSON.stringify({ ...row.context.args, title: 'a different decision' });

    const approved = await approve(kernel, store, id);
    assert.equal(approved.ok, false);
    assert.equal(approved.error.code, 'APPROVAL_BINDING_MISMATCH');
  });
});

describe('#4240 the bound approval row reaches whichever store saves it', () => {
  const { saveMcpIngestApproval } = require('../lib/mcp-ingest-execute-tool');

  it('a store with only saveToolApproval persists the executed payload as context.args', () => {
    let saved;
    const store = { saveToolApproval: (approval) => { saved = approval; return { approval, inserted: true }; } };
    const record = saveMcpIngestApproval(store, decisionArgs());
    assert.equal(record.persisted, true);
    assert.deepEqual(saved.context.args, saved.context.snapshot.payload);
    assert.ok(saved.policy.reviewedBinding, 'the saved row carries the reviewed binding');
  });

  it('no store, a store that throws, and an unconfirmed write each say why nothing persisted', (t) => {
    t.mock.method(console, 'error', () => {});
    assert.equal(saveMcpIngestApproval(null, decisionArgs()).notPersistedReason, 'approval_store_unavailable');
    const throwing = { saveToolApprovalIfAbsent: () => { throw new Error('disk full'); } };
    assert.equal(saveMcpIngestApproval(throwing, decisionArgs()).notPersistedReason, 'approval_store_write_failed');
    const silent = { saveToolApprovalIfAbsent: () => null };
    assert.equal(saveMcpIngestApproval(silent, decisionArgs()).notPersistedReason, 'approval_store_write_unconfirmed');
  });
});
