const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createServer,
  callTool,
} = require('../mcpServer');
const { evaluateMcpGate } = require('../lib/mcp-gate-adapter');
const { withMcpToolVerdictSurface } = require('../lib/mcp/response-builders');

function fixtureKernel() {
  const calls = { learn: 0, ask: 0, verify: 0 };
  return {
    calls,
    learn(text) {
      calls.learn += 1;
      return {
        ok: true,
        type: 'learn',
        data: { learned: 1, skipped: 0, text },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0.0', backend: 'fixture' },
      };
    },
    ask(question) {
      calls.ask += 1;
      return {
        ok: true,
        type: 'ask',
        data: { answer: 'fixture-answer', subject: question, unknown: false, alternatives: 0 },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0.0', backend: 'fixture' },
      };
    },
    verify(statement) {
      calls.verify += 1;
      return {
        ok: true,
        type: 'verify',
        data: { status: 'dogrulandi', confidence: 1, statement },
        evidence: [],
        error: null,
        meta: { contractVersion: '1.0.0', backend: 'fixture' },
      };
    },
    _ok(type, data) {
      return { ok: true, type, data, evidence: [], error: null, meta: {} };
    },
    _fail(type, code, message) {
      return { ok: false, type, data: null, evidence: [], error: { code, message }, meta: {} };
    },
  };
}

function fixtureApprovalStore(initial = []) {
  const records = new Map(initial.map(record => [record.id, record]));
  return {
    records,
    saveToolApproval(record) {
      records.set(record.id, record);
      return record;
    },
    getToolApprovalById(id) {
      return records.get(id) || null;
    },
    listUnresolvedToolApprovals() {
      return [...records.values()].filter(record => !['approved', 'rejected'].includes(record.status));
    },
    countUnresolvedToolApprovals() {
      return this.listUnresolvedToolApprovals().length;
    },
    claimToolApproval(id, reason) {
      const record = records.get(id);
      if (!record || record.status !== 'pending') return { claimed: false, approval: record || null };
      record.status = 'executing';
      record.updatedAt = Date.now();
      record.reason = reason;
      return { claimed: true, approval: record };
    },
    rejectToolApproval(id, reason) {
      const record = records.get(id);
      if (!record || record.status !== 'pending') return { rejected: false, approval: record || null };
      record.status = 'rejected';
      record.decision = 'rejected';
      record.reason = reason;
      record.updatedAt = Date.now();
      return { rejected: true, approval: record };
    },
    failToolApproval(id, reason) {
      const record = records.get(id);
      if (!record) return { approval: null };
      record.status = 'failed';
      record.reason = reason;
      record.updatedAt = Date.now();
      return { approval: record };
    },
    finalizeToolApprovalWithReceipt(id, { decision, reason, receipt, contextPatch }) {
      const record = records.get(id);
      if (!record) return { approval: null };
      record.status = 'approved';
      record.decision = decision;
      record.reason = reason;
      record.context = { ...(record.context || {}), receipt, ...contextPatch };
      record.updatedAt = Date.now();
      return { approval: record };
    },
  };
}

function transportCall(server, id, name, arguments_, extra = {}) {
  return server.handleRequest({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: arguments_, ...extra },
  });
}

function ingestApproval(id, workspaceId, status = 'pending') {
  return {
    id,
    approvalKey: `http.ingest.${id}`,
    tool: 'http.ingest',
    input: '{}',
    status,
    decision: status === 'approved' ? 'approved' : 'review',
    reason: 'fixture',
    createdAt: 1,
    updatedAt: 1,
    context: {
      snapshot: {
        workspaceId,
        sourceType: 'manual',
        sourceRef: 'fixture:security-matrix',
        snapshotHash: 'digest-fixture',
        idempotencyKey: 'idem-fixture',
      },
    },
  };
}

test('MCP JSON-RPC transport smoke keeps initialize, tools/list and tools/call bounded', () => {
  const server = createServer({ kernel: fixtureKernel(), approvalStore: null });
  const initialized = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const listed = server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const called = transportCall(server, 3, 'huqan.ask', { question: 'fixture question' });

  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.ok(listed.result.tools.some(tool => tool.name === 'huqan.ask'));
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.status, 'completed');
  assert.equal(called.result.structuredContent.canonicalWrite, false);
  assert.equal(called.result.structuredContent.receiptId, null);
});

test('operator-only tools stay out of model discovery and invalid operator token fails closed', () => {
  const pending = {
    id: 'approval-security-1', tool: 'huqan.learn', input: '{}', status: 'pending', decision: 'review',
    context: { args: { text: 'fixture fact' } },
  };
  const store = fixtureApprovalStore([pending]);
  const server = createServer({ kernel: fixtureKernel(), approvalStore: store, operatorToken: 'operator-secret' });
  const listed = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = listed.result.tools.map(tool => tool.name);
  const blocked = transportCall(server, 2, 'huqan.approve', { approvalId: pending.id }, { operatorToken: 'wrong-token' });
  const current = store.getToolApprovalById(pending.id);

  assert.equal(names.includes('huqan.approve'), false);
  assert.equal(names.includes('huqan.approvals'), false);
  assert.equal(names.includes('huqan.agent_resume'), false);
  assert.equal(blocked.result.isError, true);
  assert.equal(blocked.result.structuredContent.error.code, 'OPERATOR_AUTH_REQUIRED');
  assert.equal(blocked.result.structuredContent.status, 'blocked');
  assert.equal(blocked.result.structuredContent.canonicalWrite, false);
  assert.equal(current.status, 'pending');
  assert.equal(current.context.receipt, undefined);
});

test('unknown tool is blocked without state mutation or sensitive error leakage', () => {
  const kernel = fixtureKernel();
  const server = createServer({ kernel, approvalStore: null });
  const response = transportCall(server, 1, 'huqan.not_a_tool', { secret: 'do-not-leak' });
  const result = response.result.structuredContent;

  assert.equal(response.result.isError, true);
  assert.equal(result.gate.allowed, false);
  assert.equal(result.gate.canExecute, false);
  assert.equal(result.gate.decision, 'block');
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.receiptId, null);
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak/);
  assert.equal(kernel.calls.learn, 0);
});

test('approval-required learn persists candidate binding and never reports a false success', () => {
  const kernel = fixtureKernel();
  const store = fixtureApprovalStore();
  const result = callTool(kernel, {
    name: 'huqan.learn',
    arguments: {
      text: 'kedi hayvandir',
      workspaceId: 'team-a',
      provenance: { provenanceId: 'prov-security', sourceRef: 'doc:security' },
    },
  }, { approvalStore: store });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'review_required');
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.receiptId, null);
  assert.equal(result.approval.persisted, true);
  assert.ok(result.approval.approvalId);
  assert.equal(result.approval.context.candidateId, result.candidateId);
  assert.equal(result.approval.context.workspaceId, 'team-a');
  assert.equal(result.approval.context.provenance.provenanceId, 'prov-security');
  assert.equal(kernel.calls.learn, 0);
});

test('duplicate approved decision is idempotent and preserves the same receipt', () => {
  const receipt = { receiptId: 'receipt-security-1', workspaceId: 'team-a' };
  const approval = {
    id: 'approval-duplicate-1', tool: 'huqan.learn', input: '{}', status: 'approved', decision: 'approved',
    context: { receipt, executionRefs: { receiptId: receipt.receiptId } },
  };
  const store = fixtureApprovalStore([approval]);
  const server = createServer({ kernel: fixtureKernel(), approvalStore: store, operatorToken: 'operator-secret' });
  const params = { approvalId: approval.id, workspaceId: 'default', decision: 'approved' };
  const first = transportCall(server, 1, 'huqan.approve', params, { operatorToken: 'operator-secret' });
  const second = transportCall(server, 2, 'huqan.approve', params, { operatorToken: 'operator-secret' });

  for (const response of [first, second]) {
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.data.idempotent, true);
    assert.equal(response.result.structuredContent.receiptId, receipt.receiptId);
    assert.equal(response.result.structuredContent.canonicalWrite, false);
  }
  assert.deepEqual(second.result.structuredContent.data.receipt, first.result.structuredContent.data.receipt);
});

test('workspace mismatch hides an ingest run and cannot expose its receipt', () => {
  const approval = ingestApproval('run-security-1', 'team-a', 'approved');
  approval.context.receipt = { receiptId: 'receipt-private-1', workspaceId: 'team-a' };
  const store = fixtureApprovalStore([approval]);
  const server = createServer({ kernel: fixtureKernel(), approvalStore: store });
  const response = transportCall(server, 1, 'huqan.ingest_status', {
    runId: approval.id,
    workspaceId: 'team-b',
  });
  const result = response.result.structuredContent;

  assert.equal(response.result.isError, true);
  assert.equal(result.error.code, 'INGEST_RUN_NOT_FOUND');
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.receiptId, null);
  assert.doesNotMatch(JSON.stringify(result), /receipt-private-1/);
});

test('failed ingest projection is explicit and never advertises retry or successful receipt', () => {
  const approval = ingestApproval('run-security-failed', 'team-a', 'failed');
  const store = fixtureApprovalStore([approval]);
  const server = createServer({ kernel: fixtureKernel(), approvalStore: store });
  const response = transportCall(server, 1, 'huqan.ingest_status', {
    runId: approval.id,
    workspaceId: 'team-a',
  });
  const result = response.result.structuredContent;

  assert.equal(response.result.isError, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.data.retry.allowed, false);
  assert.equal(result.receiptId, null);
  assert.equal(result.canonicalWrite, false);
});

test('approved MCP ingest initializes the company runtime on a real server-created kernel', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-ingest-runtime-'));
  const previousCwd = process.cwd();
  const environmentKeys = ['AXIOM_MEMORY_PATH', 'AXIOM_DB_PATH', 'AXIOM_USE_SQLITE'];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  let server = null;

  try {
    process.chdir(tempDir);
    process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'graph.json');
    process.env.AXIOM_DB_PATH = path.join(tempDir, 'graph.db');
    process.env.AXIOM_USE_SQLITE = 'true';

    server = createServer({ operatorToken: 'mcp-runtime-test-operator' });
    let pluginLoadCalls = 0;
    let pluginLoadArgs = null;
    const originalPluginLoad = server.kernel.plugins?.load;
    assert.equal(typeof originalPluginLoad, 'function');
    server.kernel.plugins.load = (...args) => {
      pluginLoadCalls += 1;
      pluginLoadArgs = args;
      return originalPluginLoad.apply(server.kernel.plugins, args);
    };

    const pendingResponse = await transportCall(server, 1, 'huqan.ingest_execute', {
      sourceType: 'manual',
      workspaceId: 'default',
      idempotencyKey: 'mcp-runtime-initialization-regression',
      text: 'MCP runtime initialization regression fact.',
      title: 'MCP runtime regression',
      author: 'test',
      rationale: 'Verify approved ingest initializes capabilities before execution.',
    });
    const pending = pendingResponse.result.structuredContent;
    assert.equal(pendingResponse.result.isError, true);
    assert.equal(pending.status, 'review_required');
    assert.equal(pending.canonicalWrite, false);
    const approvalId = pending.approval?.id || pending.approvalId;
    assert.ok(approvalId);

    const approvedResponse = await transportCall(server, 2, 'huqan.approve', {
      approvalId,
      workspaceId: 'default',
      decision: 'approved',
      reason: 'runtime initialization regression test',
    }, { operatorToken: 'mcp-runtime-test-operator' });
    const approved = approvedResponse.result.structuredContent;

    assert.equal(approvedResponse.result.isError, false);
    assert.equal(approved.ok, true);
    assert.equal(approved.status, 'completed');
    assert.equal(approved.data.decision, 'approved');
    assert.equal(approved.data.executed, true);
    assert.equal(approved.data.idempotent, false);
    assert.equal(approved.canonicalWrite, false);
    assert.ok(approved.receiptId);
    assert.equal(server.kernel.hasCapability('companyMode'), true);
    assert.equal(server.kernel.hasCapability('pluginCapabilities'), true);
    assert.equal(pluginLoadCalls, 1);
    assert.deepEqual(pluginLoadArgs, [path.join(__dirname, '..', 'plugins')]);
  } finally {
    try { server?.approvalStore?.close?.(); } catch (_) {}
    process.chdir(previousCwd);
    for (const key of environmentKeys) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('policy denial and partial-run surfaces remain fail-closed and receipt-free', () => {
  const deniedGate = evaluateMcpGate({
    tool: 'huqan.ask',
    args: { workspaceId: 'team-b', operation: 'read' },
    metadata: { workspaceId: 'team-a' },
  });
  const denied = withMcpToolVerdictSurface({
    ok: false,
    type: 'policy',
    error: { code: 'POLICY_DENIED', message: 'Cross-workspace access denied.' },
    evidence: [],
    meta: {},
  }, 'huqan.ask', {}, deniedGate);
  const partial = withMcpToolVerdictSurface({
    ok: true,
    type: 'agent',
    data: { status: 'partial', runId: 'run-partial-1', nextAction: 'resume', steps: [] },
    evidence: [],
    error: null,
    meta: {},
  }, 'huqan.agent', {}, { decision: 'dry_run_only', reason: 'agent_loop_dry_run_only' });

  assert.equal(deniedGate.decision, 'block');
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.canonicalWrite, false);
  assert.equal(denied.receiptId, null);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.canonicalWrite, false);
  assert.equal(partial.receiptId, null);
  assert.equal(partial.trace.runId, 'run-partial-1');
  assert.equal(partial.trace.nextAction, 'resume');
});
