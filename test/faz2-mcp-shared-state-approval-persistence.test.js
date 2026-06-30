'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../mcpServer');

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withTempAxiomEnv(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-faz2-mcp-'));
  const saved = {
    AXIOM_MEMORY_PATH: process.env.AXIOM_MEMORY_PATH,
    AXIOM_DB_PATH: process.env.AXIOM_DB_PATH,
    AXIOM_KERNEL_VERSION: process.env.AXIOM_KERNEL_VERSION,
    AXIOM_USE_SQLITE: process.env.AXIOM_USE_SQLITE,
  };
  process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
  process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
  process.env.AXIOM_KERNEL_VERSION = '';
  delete process.env.AXIOM_USE_SQLITE;

  try {
    return await fn({ tempDir });
  } finally {
    restoreEnv(saved);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function closeServer(server) {
  try { server?.kernel?.graph?.close?.(); } catch (_) {}
  try { server?.approvalStore?.close?.(); } catch (_) {}
}

function callTool(server, name, args = {}) {
  const response = server.handleRequest({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1_000_000),
    method: 'tools/call',
    params: { name, arguments: args },
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result, `${name} must return a JSON-RPC result`);
  assert.ok(response.result.structuredContent, `${name} must return structured content`);
  return response.result.structuredContent;
}

function pendingApprovalIds(server) {
  const approvals = callTool(server, 'axiom.approvals', { limit: 20 });
  assert.ok(Array.isArray(approvals.approvals));
  return approvals.approvals.map((item) => item.id);
}

function learnAuditCount(server, text) {
  return server.kernel.graph
    .getAuditEvents({ workspaceId: 'default' })
    .filter((event) => event.eventType === 'LEARN' && event.details?.text === text)
    .length;
}

test('FAZ2-5: MCP approval request persists across server restart', async () => {
  await withTempAxiomEnv(async () => {
    const text = 'faz2 mcp persistence sentinel hayvandir';
    let server = createServer();
    const queued = callTool(server, 'axiom.learn', { text });

    assert.equal(queued.ok, false);
    assert.equal(queued.gate.decision, 'review');
    assert.equal(queued.approval.status, 'pending');
    const approvalId = queued.approval.id;
    closeServer(server);

    server = createServer();
    assert.ok(
      pendingApprovalIds(server).includes(approvalId),
      'pending MCP approval must survive a fresh server instance'
    );
    closeServer(server);
  });
});

test('FAZ2-5: rejecting a persisted MCP approval does not execute the mutation', async () => {
  await withTempAxiomEnv(async () => {
    const text = 'faz2 mcp reject sentinel hayvandir';
    let server = createServer();
    const queued = callTool(server, 'axiom.learn', { text });
    const approvalId = queued.approval.id;
    closeServer(server);

    server = createServer();
    const rejected = callTool(server, 'axiom.approve', {
      approvalId,
      decision: 'rejected',
      reason: 'test rejection',
    });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.data.decision, 'rejected');
    assert.equal(rejected.data.executed, false);
    assert.equal(rejected.data.approval.status, 'rejected');

    const verify = callTool(server, 'axiom.verify', { statement: text });
    assert.equal(verify.data.status, 'bilinmiyor');
    assert.ok(!pendingApprovalIds(server).includes(approvalId));
    closeServer(server);
  });
});

test('FAZ2-5: approving a persisted MCP approval executes once through admission-aware learn', async () => {
  await withTempAxiomEnv(async () => {
    const text = 'faz2 mcp approve sentinel hayvandir';
    let server = createServer();
    const queued = callTool(server, 'axiom.learn', { text });
    const approvalId = queued.approval.id;
    closeServer(server);

    server = createServer();
    assert.equal(callTool(server, 'axiom.verify', { statement: text }).data.status, 'bilinmiyor');

    const approved = callTool(server, 'axiom.approve', {
      approvalId,
      decision: 'approved',
      reason: 'test approval',
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.data.decision, 'approved');
    assert.equal(approved.data.executed, true);
    assert.equal(approved.data.idempotent, false);
    assert.equal(approved.data.approval.status, 'approved');
    assert.equal(approved.data.result.data.admission.outcome, 'allow');
    assert.equal(approved.data.result.data.admission.approvalStatus, 'approved');

    const auditCountAfterApprove = learnAuditCount(server, text);
    assert.ok(auditCountAfterApprove >= 1, 'approved execution must emit LEARN audit');
    assert.equal(callTool(server, 'axiom.verify', { statement: text }).data.status, 'dogrulandi');

    const duplicate = callTool(server, 'axiom.approve', {
      approvalId,
      decision: 'approved',
      reason: 'duplicate approval must be idempotent',
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.data.executed, false);
    assert.equal(duplicate.data.idempotent, true);
    assert.equal(learnAuditCount(server, text), auditCountAfterApprove);
    closeServer(server);
  });
});

test('FAZ2-5: createServer can use an injected shared kernel instance', () => {
  const injectedKernel = {
    learn() { return { ok: true, type: 'learn', data: {}, evidence: [], error: null, meta: {} }; },
    ask() { return { ok: true, type: 'ask', data: { answer: 'injected' }, evidence: [], error: null, meta: {} }; },
    verify() { return { ok: true, type: 'verify', data: { status: 'bilinmiyor', confidence: 0 }, evidence: [], error: null, meta: {} }; },
  };

  const server = createServer(injectedKernel);
  assert.equal(server.kernel, injectedKernel);
  const result = callTool(server, 'axiom.ask', { question: 'shared?' });
  assert.equal(result.data.answer, 'injected');
});
