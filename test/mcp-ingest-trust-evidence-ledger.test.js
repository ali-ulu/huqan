'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const {
  callTool,
  createServer,
  createMcpOperatorCapability,
  operatorCapabilityBinding,
} = require('../mcpServer');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');

function makeKernel(graph) {
  const calls = [];
  return {
    graph,
    calls,
    _ok: (op, data) => ({ ok: true, type: op, data, evidence: [], error: null, meta: {} }),
    _fail: (op, code, message) => ({ ok: false, type: op, data: null, evidence: [], error: { code, message }, meta: {} }),
    runCapability: async (capability, payload) => {
      calls.push({ capability, payload });
      return {
        ok: true,
        admission: {
          outcome: 'allow',
          graphWrite: true,
          entries: [{ workspaceId: 'default', receiptId: 'operation-receipt', auditId: 'operation-audit', graphWrite: true }],
        },
        evidence: [],
      };
    },
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

function queue(kernel, approvalStore) {
  return callTool(kernel, {
    name: 'huqan.ingest_execute',
    arguments: JSON.stringify({ sourceType: 'manual', workspaceId: 'default', text: 'ledger test', title: 'ledger' }),
  }, { approvalStore });
}

test('MCP approval owner appends bounded trust evidence through the opt-in ledger', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-ledger-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  t.after(() => { graph.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const kernel = makeKernel(graph);
  const approvalStore = makeApprovalStore();
  const ledger = createTrustEvidenceLedger({ graph });
  const queued = queue(kernel, approvalStore);
  const approvalArgs = { approvalId: queued.approval.id, workspaceId: 'default', decision: 'approved', reason: 'ledger_test_approved' };
  const result = await callTool(kernel, {
    name: 'huqan.approve',
    arguments: JSON.stringify(approvalArgs),
    operatorCapability: createMcpOperatorCapability({ secret: 'test-operator', ...operatorCapabilityBinding('huqan.approve', approvalArgs) }),
  }, { approvalStore, operatorSecret: 'test-operator', operatorCapabilityNonces: new Map(), trustEvidenceLedger: ledger });

  assert.equal(result.ok, true);
  assert.equal(result.data.refs.auditRef !== undefined, true);
  const evidence = ledger.readByOperation(`trust-evidence:ingest-approval:${queued.approval.id}`);
  assert.ok(evidence);
  assert.equal(evidence.verification.valid, true);
  assert.equal(evidence.receipt.canonicalPayload.receiptKind, 'trust_evidence');
  assert.equal(evidence.receipt.canonicalPayload.decision, 'allow');
  assert.equal(kernel.calls.length, 1);
});

test('MCP createServer passes its opt-in ledger into the approval runtime', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-server-ledger-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  t.after(() => { graph.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const kernel = { ...makeKernel(graph), learn() {} };
  const approvalStore = makeApprovalStore();
  const ledger = createTrustEvidenceLedger({ graph });
  const server = createServer({ kernel, approvalStore, operatorToken: 'test-operator', trustEvidenceLedger: ledger });
  const queuedResponse = server.handleRequest({
    id: 'queue',
    method: 'tools/call',
    params: {
      name: 'huqan.ingest_execute',
      arguments: JSON.stringify({ sourceType: 'manual', workspaceId: 'default', text: 'server ledger', title: 'server' }),
    },
  });
  const queued = queuedResponse.result.structuredContent;
  assert.equal(queued.ok, false);
  const approvedResponse = await server.handleRequest({
    id: 'approve',
    method: 'tools/call',
    params: {
      name: 'huqan.approve',
      arguments: JSON.stringify({ approvalId: queued.approval.id, workspaceId: 'default', decision: 'approved', reason: 'server_ledger_test' }),
      operatorCapability: createMcpOperatorCapability({
        secret: 'test-operator',
        ...operatorCapabilityBinding('huqan.approve', { approvalId: queued.approval.id, workspaceId: 'default', decision: 'approved', reason: 'server_ledger_test' }),
      }),
    },
  });
  assert.equal(approvedResponse.result.structuredContent.ok, true);
  const evidence = ledger.readByOperation(`trust-evidence:ingest-approval:${queued.approval.id}`);
  assert.equal(evidence?.verification.valid, true);
});
