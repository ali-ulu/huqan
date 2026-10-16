'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { buildIngestApprovalSnapshot } = require('../lib/ingest');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { decideIngestApproval } = require('../lib/workbench/ingest-approval-action');

function approvalStore(initial) {
  let current = structuredClone(initial);
  return {
    getToolApprovalById(id) {
      return current && current.id === id ? structuredClone(current) : null;
    },
    claimToolApprovalWithLease(id, { owner, leaseMs, reason }) {
      if (!current || current.id !== id || current.status !== 'pending') {
        return { claimed: false, approval: current && structuredClone(current) };
      }
      current = { ...current, status: 'executing', leaseOwner: owner, leaseMs, reason, updatedAt: Date.now() };
      return { claimed: true, approval: structuredClone(current) };
    },
    renewToolApprovalLease(id, owner) {
      return { renewed: Boolean(current && current.id === id && current.status === 'executing' && current.leaseOwner === owner) };
    },
    failToolApproval(id, reason) {
      if (current?.id === id) current = { ...current, status: 'failed', reason, updatedAt: Date.now() };
      return { approval: current && structuredClone(current) };
    },
    finalizeToolApprovalWithReceipt(id, { expectedStatus, decision, reason, receipt }) {
      if (!current || current.id !== id || current.status !== expectedStatus || !receipt) {
        return { finalized: false, approval: current && structuredClone(current) };
      }
      current = {
        ...current,
        status: decision === 'approved' ? 'approved' : 'rejected',
        decision,
        reason,
        updatedAt: Date.now(),
        context: { ...(current.context || {}), receipt },
      };
      return { finalized: true, approval: structuredClone(current) };
    },
  };
}

function fixture({ approverAllowed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-942-http-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const ledger = createTrustEvidenceLedger({ graph });
  const snapshot = buildIngestApprovalSnapshot({
    sourceType: 'manual',
    workspaceId: 'default',
    text: 'HTTP Human Oversight bounded candidate.',
    sourceRef: 'source://http-oversight/1',
  });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const approval = {
    id: 'http-approval-942-1',
    approvalKey: `http.ingest.manual.${snapshot.idempotencyKey}.${snapshot.snapshotHash}`,
    tool: 'http.ingest',
    status: 'pending',
    decision: 'review',
    reason: 'http_ingest_requires_review',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    context: { source: 'http-ingest', snapshot, oversightRequired: true },
    policy: { action: 'ingest', approval: 'review' },
  };
  let executions = 0;
  const runtime = createHumanOversightApprovalRuntime({
    graph,
    ledger,
    clock: () => Date.parse('2026-08-20T10:00:00.000Z'),
    resolveIdentity: ({ role, action }) => {
      if (role === 'approver' && !approverAllowed) {
        return { decision: 'block', allowed: false, reason: 'identity.unknown' };
      }
      return {
        decision: 'allow',
        identity: {
          identityRef: role === 'requester' ? 'agent:http-worker' : 'human:http-operator',
          identityHash: role === 'requester' ? 'hash-http-worker' : 'hash-http-operator',
          workspaceId: action.workspaceId,
          agentId: role === 'requester' ? 'agent-http-worker' : '',
          ownerActorId: role === 'requester' ? 'owner-http' : 'operator-http',
          authorityRef: 'authority:http-workspace',
        },
      };
    },
    firewallEvaluator: () => ({ decision: 'allow', metadata: { firewallVersion: 'AAFW-v1.0.0' } }),
  });
  const humanOversight = {
    runtime,
    humanOversightRequesterContext: {
      subject: 'http-receiver-owner',
      kind: 'http-server',
    },
    humanOversightApproverContext: {
      subject: 'human:http-operator',
      kind: 'operator',
    },
  };
  return {
    dir,
    graph,
    store: approvalStore(approval),
    runtime,
    humanOversight,
    approval,
    get executions() { return executions; },
    execute: async ({ kernel, recordAudit }) => decideIngestApproval({
      store: approvalStore(approval),
      kernel,
      approvalId: approval.id,
      decision: 'approved',
      reason: 'bounded_http_operator_review',
      humanOversight,
      handleIngest: async () => {
        executions += 1;
        return {
          ok: true,
          admission: {
            outcome: 'allow',
            graphWrite: false,
            entries: [{ workspaceId: 'default', receiptId: 'receipt-http-942-1', auditId: 'audit-http-942-1', graphWrite: false }],
          },
        };
      },
      ensureRuntime: () => {},
      recordAudit,
      toPublicApproval: value => value,
      workerId: 'http-test-worker',
      leaseMs: 30_000,
    }),
  };
}

test('HTTP ingest Human Oversight allows a receiver-owned approved execution', async () => {
  const f = fixture();
  try {
    const result = await decideIngestApproval({
      store: f.store,
      kernel: {},
      approvalId: f.approval.id,
      decision: 'approved',
      reason: 'bounded_http_operator_review',
      humanOversight: f.humanOversight,
      handleIngest: async () => {
        f._executions = (f._executions || 0) + 1;
        return {
          ok: true,
          admission: {
            outcome: 'allow',
            graphWrite: false,
            entries: [{ workspaceId: 'default', receiptId: 'receipt-http-942-1', auditId: 'audit-http-942-1', graphWrite: false }],
          },
        };
      },
      ensureRuntime: () => {},
      recordAudit: () => ({ auditId: 'audit-http-942-1' }),
      toPublicApproval: value => value,
      workerId: 'http-test-worker',
      leaseMs: 30_000,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.json.ok, true);
    assert.equal(result.json.oversight.decisionType, 'approve');
    assert.equal(result.json.oversight.status, 'executed');
    assert.equal(f._executions, 1);
    assert.equal(f.store.getToolApprovalById(f.approval.id).status, 'approved');
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('HTTP ingest Human Oversight blocks before claim and executor when approver identity is rejected', async () => {
  const f = fixture({ approverAllowed: false });
  let executions = 0;
  try {
    const result = await decideIngestApproval({
      store: f.store,
      kernel: {},
      approvalId: f.approval.id,
      decision: 'approved',
      reason: 'bounded_http_operator_review',
      humanOversight: f.humanOversight,
      handleIngest: async () => {
        executions += 1;
        return { ok: true, admission: { outcome: 'allow', graphWrite: false, entries: [] } };
      },
      ensureRuntime: () => {},
      recordAudit: () => ({ auditId: 'audit-http-942-blocked' }),
      toPublicApproval: value => value,
      workerId: 'http-test-worker',
      leaseMs: 30_000,
    });
    assert.equal(result.error.code, 'OVERSIGHT_DECISION_FAILED');
    assert.equal(f.store.getToolApprovalById(f.approval.id).status, 'pending');
    assert.equal(executions, 0);
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('failed approved oversight does not start a lease heartbeat before returning', async () => {
  const actionModule = require.resolve('../lib/workbench/ingest-approval-action');
  const adapterModule = require.resolve('../lib/http-human-oversight-adapter');
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalAdapter = require(adapterModule);
  const f = fixture();
  let intervalStarts = 0;
  let intervalClears = 0;
  let executions = 0;

  delete require.cache[actionModule];
  Module._load = function patchedLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === adapterModule) {
      return {
        ...originalAdapter,
        prepareHttpIngestOversightDecision: () => ({
          ok: true,
          oversightCase: { enabled: true },
          oversightDecision: { enabled: true, ok: false },
          identityEvaluation: { enabled: false, ok: true },
        }),
      };
    }
    return originalLoad.apply(this, arguments);
  };
  global.setInterval = (...args) => {
    intervalStarts += 1;
    return originalSetInterval(...args);
  };
  global.clearInterval = handle => {
    intervalClears += 1;
    return originalClearInterval(handle);
  };

  try {
    const { decideIngestApproval: isolatedDecideIngestApproval } = require(actionModule);
    const result = await isolatedDecideIngestApproval({
      store: f.store,
      kernel: {},
      approvalId: f.approval.id,
      decision: 'approved',
      reason: 'bounded_http_operator_review',
      handleIngest: async () => {
        executions += 1;
        return { ok: true, admission: { outcome: 'allow', graphWrite: false, entries: [] } };
      },
      ensureRuntime: () => {},
      recordAudit: () => ({ auditId: 'audit-http-heartbeat-cleanup' }),
      toPublicApproval: value => value,
      workerId: 'http-test-worker',
      leaseMs: 10_000,
    });

    assert.equal(result.error.code, 'OVERSIGHT_DECISION_FAILED');
    assert.equal(f.store.getToolApprovalById(f.approval.id).status, 'failed');
    assert.equal(executions, 0);
    assert.equal(intervalStarts, 0);
    assert.equal(intervalClears, 0);
  } finally {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    delete require.cache[actionModule];
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
