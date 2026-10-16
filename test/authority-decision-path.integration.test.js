'use strict';

// ADR-016 / #3560: with an approval authority installed, code running as the
// interactive user cannot approve its own action, whatever it holds in-process.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { callTool, createServer } = require('../mcpServer');
const { canonicalActionHash } = require('../lib/mcp-operator-capability');
const { canonicalMcpToolName } = require('../lib/mcp-tool-names');
const { signDecision, DECISION_VERSION } = require('../lib/authority/decision-envelope');
const { signConsumption } = require('../lib/authority/consumption-envelope');

const signing = crypto.generateKeyPairSync('ed25519');
const SERVICE = Object.freeze({ mode: 'service', boundary: 'os-service', pin: { signingKey: signing.publicKey } });

function withServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-path-'));
  const saved = { mem: process.env.HUQAN_MEMORY_PATH, db: process.env.HUQAN_DB_PATH };
  process.env.HUQAN_MEMORY_PATH = path.join(dir, 'memory.json');
  process.env.HUQAN_DB_PATH = path.join(dir, 'memory.db');
  const server = createServer();
  t.after(() => {
    server.kernel.graph.close?.();
    server.approvalStore?.close?.();
    for (const [key, value] of [['HUQAN_MEMORY_PATH', saved.mem], ['HUQAN_DB_PATH', saved.db]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return server;
}

function envelopeFor(approval, overrides = {}) {
  const tool = canonicalMcpToolName(approval.tool);
  const args = approval.context?.args || JSON.parse(approval.input || '{}');
  const now = Date.now();
  return signDecision({ v: DECISION_VERSION, approvalId: approval.id, workspaceId: 'default', tool,
    actionHash: canonicalActionHash({ tool, workspaceId: 'default', approvalId: approval.id, arguments: args }),
    decision: 'approved', reason: 'operator checked it', decidedAt: new Date(now - 1000).toISOString(),
    validUntil: new Date(now + 5 * 60 * 1000).toISOString(), ledgerSeq: 1, ledgerHash: 'b'.repeat(64),
    operator: 'totp:primary', ...overrides }, signing.privateKey);
}

function queue(server, text) {
  const queued = callTool(server.kernel, { name: 'huqan.learn', arguments: { text } },
    { approvalStore: server.approvalStore, operatorToken: 'operator-secret' });
  assert.equal(queued.approval.status, 'pending');
  return server.approvalStore.getToolApprovalById(queued.approval.id);
}

function approve(server, approvalId, runtime, extraArgs = {}) {
  return callTool(server.kernel, { name: 'huqan.approve', operatorToken: 'operator-secret',
    arguments: { approvalId, workspaceId: 'default', decision: 'approved', ...extraArgs } },
  { approvalStore: server.approvalStore, operatorToken: 'operator-secret', approvalAuthorityMode: SERVICE, ...runtime });
}

test('an in-process caller holding the operator credential cannot approve without the authority', (t) => {
  const server = withServer(t);
  const row = queue(server, 'authority path sentinel one hayvandir');
  const result = approve(server, row.id, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTHORITY_DECISION_REQUIRED');
  assert.equal(server.approvalStore.getToolApprovalById(row.id).status, 'pending', 'nothing was claimed or executed');
});

test('the authority decision for exactly this action executes it', (t) => {
  const server = withServer(t);
  const row = queue(server, 'authority path sentinel two hayvandir');
  const decided = envelopeFor(row);
  const withoutConsumption = approve(server, row.id, { authorityDecision: decided });
  assert.equal(withoutConsumption.error.code, 'AUTHORITY_CONSUMPTION_REQUIRED');
  const consumption = signConsumption({ approvalId: row.id, workspaceId: 'default', tool: decided.payload.tool,
    actionHash: decided.payload.actionHash, ledgerSeq: 2, ledgerHash: 'c'.repeat(64), consumedAt: new Date().toISOString() },
  signing.privateKey);
  const result = approve(server, row.id, { authorityDecision: decided, authorityConsumption: consumption });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data.executed, true);
});

test('a decision signed for other arguments or another approval does not execute this one', (t) => {
  const server = withServer(t);
  const row = queue(server, 'authority path sentinel three hayvandir');
  const other = queue(server, 'authority path sentinel four hayvandir');
  for (const envelope of [envelopeFor(other), envelopeFor(row, { actionHash: 'c'.repeat(64) }), envelopeFor(row, { decision: 'rejected' })]) {
    const result = approve(server, row.id, { authorityDecision: envelope });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AUTHORITY_DECISION_INVALID');
  }
  assert.equal(server.approvalStore.getToolApprovalById(row.id).status, 'pending');
});

test('a rejection also needs the authority, so an agent cannot discard what the operator has not seen', (t) => {
  const server = withServer(t);
  const row = queue(server, 'authority path sentinel five hayvandir');
  const result = callTool(server.kernel, { name: 'huqan.approve', operatorToken: 'operator-secret',
    arguments: { approvalId: row.id, workspaceId: 'default', decision: 'rejected' } },
  { approvalStore: server.approvalStore, operatorToken: 'operator-secret', approvalAuthorityMode: SERVICE });
  assert.equal(result.error.code, 'AUTHORITY_DECISION_REQUIRED');
  assert.equal(server.approvalStore.getToolApprovalById(row.id).status, 'pending');
});
