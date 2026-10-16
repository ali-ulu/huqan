'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { buildIngestApprovalSnapshot } = require('../lib/ingest');
const {
  snapshotAgentIdentityAuthority,
} = require('../lib/agent-identity-runtime');
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
      current = { ...current, status: 'executing', leaseOwner: owner, leaseMs, reason };
      return { claimed: true, approval: structuredClone(current) };
    },
    renewToolApprovalLease(id, owner) {
      return { renewed: Boolean(current && current.id === id && current.status === 'executing' && current.leaseOwner === owner) };
    },
    failToolApproval(id, reason) {
      if (current?.id === id) current = { ...current, status: 'failed', reason };
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
        context: { ...(current.context || {}), receipt },
      };
      return { finalized: true, approval: structuredClone(current) };
    },
  };
}

function identityRecord(ownerActorId = 'actor-http-owner') {
  return {
    agent_id: 'agent-http-worker',
    agent_type: 'local',
    display_name: 'HTTP Worker Agent',
    owner_actor_id: ownerActorId,
    workspace_id: 'default',
    delegation_scope: ['execute:http.ingest'],
    allowed_tools: ['http.ingest'],
    allowed_memory_scopes: ['read_only_context'],
    allowed_connectors: ['http:ingest'],
    risk_tier: 'low',
    trust_tier: 'probationary',
    policy_version: 'http-identity-v1',
    issued_at: '2026-08-19T00:00:00.000Z',
    expires_at: '2027-08-19T00:00:00.000Z',
    revoked_at: null,
    revocation_reason: null,
    parent_agent_id: null,
    delegation_chain: [],
    receipt_refs: ['receipt-http-identity'],
    provenance_refs: ['provenance-http-identity'],
    audit_requirements: ['trust_receipt', 'provenance_ref'],
    verification_status: 'registered',
    expected_status: 'valid',
    expected_reason_code: null,
  };
}

function fixture({ receiverSubject = 'actor-http-owner' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-940-http-identity-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const snapshot = buildIngestApprovalSnapshot({
    sourceType: 'manual',
    workspaceId: 'default',
    text: 'HTTP Agent Identity bounded candidate.',
    sourceRef: 'source://http-identity/1',
  });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const approval = {
    id: 'http-identity-approval-1',
    approvalKey: `http.ingest.manual.${snapshot.idempotencyKey}.${snapshot.snapshotHash}`,
    tool: 'http.ingest',
    status: 'pending',
    decision: 'review',
    reason: 'http_ingest_requires_review',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    context: { source: 'http-ingest', snapshot },
    policy: { action: 'ingest', approval: 'review' },
  };
  const authority = snapshotAgentIdentityAuthority({
    workspaceId: 'default',
    identities: [{ ref: 'identity:http-worker', record: identityRecord() }],
    clock: () => Date.parse('2026-08-20T10:00:00.000Z'),
  });
  const humanOversight = {
    agentIdentityRuntime: {
      authority,
      identityRef: 'identity:http-worker',
      receiver: { subject: receiverSubject, kind: 'http-server', workspaceId: 'default' },
      action: {
        capability: 'execute:http.ingest',
        target: 'source://http-identity/1',
        riskTier: 'low',
        tool: 'http.ingest',
        connector: 'http:ingest',
      },
    },
  };
  return { dir, graph, approval, store: approvalStore(approval), humanOversight };
}

function decide(fixture) {
  let executions = 0;
  return {
    run: () => decideIngestApproval({
      store: fixture.store,
      kernel: {},
      approvalId: fixture.approval.id,
      decision: 'approved',
      reason: 'http_identity_review',
      humanOversight: fixture.humanOversight,
      handleIngest: async () => {
        executions += 1;
        return {
          ok: true,
          admission: {
            outcome: 'allow',
            graphWrite: false,
            entries: [{ workspaceId: 'default', receiptId: 'receipt-http-identity-1', auditId: 'audit-http-identity-1', graphWrite: false }],
          },
        };
      },
      ensureRuntime: () => {},
      recordAudit: () => ({ auditId: 'audit-http-identity-1' }),
      toPublicApproval: value => value,
      workerId: 'http-identity-test-worker',
      leaseMs: 30_000,
    }),
    get executions() { return executions; },
  };
}

test('HTTP ingest Agent Identity allows receiver-owned identity before execution', async () => {
  const f = fixture();
  try {
    const decision = decide(f);
    const result = await decision.run();
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.json.ok, true);
    assert.equal(result.json.identity.allowed, true);
    assert.equal(result.json.identity.decision, 'allow');
    assert.equal(result.json.identity.identity.identityRef, 'identity:http-worker');
    assert.equal(result.json.identity.claim, undefined);
    assert.equal(result.json.identity.token, undefined);
    assert.equal(decision.executions, 1);
    assert.equal(f.store.getToolApprovalById(f.approval.id).status, 'approved');
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('HTTP ingest Agent Identity blocks receiver-owner mismatch before claim and executor', async () => {
  const f = fixture({ receiverSubject: 'actor-not-owner' });
  try {
    const decision = decide(f);
    const result = await decision.run();
    assert.equal(result.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED', JSON.stringify(result));
    assert.equal(result.error.details.identity.allowed, false);
    assert.equal(f.store.getToolApprovalById(f.approval.id).status, 'pending');
    assert.equal(decision.executions, 0);
  } finally {
    f.graph.close?.();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
