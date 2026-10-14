'use strict';

// Shared fixture for the MCP approval path with receiver-owned Agent Identity
// (#940 wiring, #3874/#3875/#3876 revocation scenarios). An in-memory approval
// store, a Human Oversight runtime, an identity authority snapshot and a
// counting kernel, so a test can prove whether the executor ever ran.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../../graph');
const { createMcpOperatorCapability, operatorCapabilityBinding } = require('../../mcpServer');
const { createHumanOversightApprovalRuntime } = require('../../lib/human-oversight-approval-runtime');
const { createTrustEvidenceLedger } = require('../../lib/trust-evidence-ledger');
const { snapshotAgentIdentityAuthority } = require('../../lib/agent-identity-runtime');

const FIXTURE_NOW_MS = Date.parse('2026-08-19T10:00:00.000Z');

function approvalStore({ onClaim = null } = {}) {
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
      if (onClaim) onClaim();
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

function identityRecord(overrides = {}) {
  return {
    agent_id: 'agent-mcp-001',
    agent_type: 'local',
    display_name: 'MCP Approval Agent',
    owner_actor_id: 'mcp-receiver-owner',
    workspace_id: 'workspace-mcp',
    delegation_scope: ['learn'],
    allowed_tools: ['huqan.learn'],
    allowed_memory_scopes: ['read_write_context'],
    allowed_connectors: ['mcp:huqan.learn'],
    risk_tier: 'low',
    trust_tier: 'probationary',
    policy_version: 'mcp-identity-v1',
    issued_at: '2026-08-19T00:00:00.000Z',
    expires_at: '2027-08-19T00:00:00.000Z',
    revoked_at: null,
    revocation_reason: null,
    parent_agent_id: null,
    delegation_chain: [],
    receipt_refs: ['receipt-mcp-001'],
    provenance_refs: ['provenance-mcp-001'],
    audit_requirements: ['trust_receipt'],
    verification_status: 'registered',
    expected_status: 'valid',
    expected_reason_code: null,
    ...overrides,
  };
}

function identityRuntime({ identities, identityRef = 'identity:mcp-001', clock, workspaceId = 'workspace-mcp' }) {
  return {
    authority: snapshotAgentIdentityAuthority({ workspaceId, identities, clock }),
    identityRef,
    receiver: { subject: 'mcp-receiver-owner', kind: 'mcp-server', workspaceId },
    action: {
      capability: 'learn',
      target: 'memory://mcp-approval',
      riskTier: 'low',
      tool: null,
      connector: 'mcp:huqan.learn',
    },
  };
}

function oversightRuntime({ graph, clock }) {
  return createHumanOversightApprovalRuntime({
    graph,
    ledger: createTrustEvidenceLedger({ graph }),
    clock,
    humanOversightRequesterContext: undefined,
    resolveIdentity: ({ role, context, action }) => ({
      decision: 'allow',
      identity: {
        identityRef: context?.identityRef || (role === 'requester' ? 'agent:worker-a' : 'human:operator-a'),
        identityHash: context?.identityHash || (role === 'requester' ? 'hash-worker-a' : 'hash-operator-a'),
        workspaceId: action.workspaceId,
        agentId: role === 'requester' ? 'agent-a' : '',
        ownerActorId: role === 'requester' ? 'owner-a' : context?.identityRef || 'operator-a',
        authorityRef: 'authority:workspace-mcp',
      },
    }),
    firewallEvaluator: () => ({ decision: 'allow', metadata: { firewallVersion: 'AAFW-v1.0.0' } }),
  });
}

function countingKernel(graph, onLearn) {
  return {
    graph,
    learn(text, options) {
      onLearn();
      return {
        ok: true,
        type: 'learn',
        data: {
          learned: 1,
          text,
          receipt: {
            receiptId: 'mcp-identity-learn-receipt',
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
}

/**
 * @param {object} [options]
 * @param {string} [options.ownerActorId] owner on the default identity record
 * @param {Array<{ref: string, record: object}>} [options.identities] authority contents
 * @param {string} [options.identityRef] identity the receiver claims
 * @param {Function} [options.onClaim] runs inside claimToolApproval, after the row is executing
 */
function fixture({ ownerActorId = 'mcp-receiver-owner', identities = null, identityRef = 'identity:mcp-001', onClaim = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-940-mcp-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  let nowMs = FIXTURE_NOW_MS;
  let executions = 0;
  const clock = () => nowMs;
  const authorityIdentities = identities || [{ ref: 'identity:mcp-001', record: identityRecord({ owner_actor_id: ownerActorId }) }];
  const f = {
    dir,
    graph,
    kernel: countingKernel(graph, () => { executions += 1; }),
    oversight: oversightRuntime({ graph, clock }),
    clock,
    agentIdentityRuntime: identityRuntime({ identities: authorityIdentities, identityRef, clock }),
    get executions() { return executions; },
    advanceClock(ms) { nowMs += ms; },
    cleanup() {
      graph.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  f.store = approvalStore({ onClaim: onClaim ? () => onClaim(f) : null });
  return f;
}

function queueParams() {
  return {
    name: 'huqan.learn',
    arguments: JSON.stringify({
      text: 'MCP Agent Identity bounded candidate.',
      workspaceId: 'workspace-mcp',
      provenance: { sourceRef: 'source://identity/1', sourceType: 'manual', confidence: 0.8 },
    }),
  };
}

function operatorParams(name, args) {
  return {
    name,
    operatorCapability: createMcpOperatorCapability({
      secret: 'operator-token',
      ...operatorCapabilityBinding(name, args),
    }),
    arguments: JSON.stringify(args),
  };
}

function runtimeOptions(f, overrides = {}) {
  return {
    approvalStore: f.store,
    operatorSecret: 'operator-token',
    operatorCapabilityNonces: new Map(),
    humanOversightApprovalRuntime: f.oversight,
    humanOversightRequesterContext: {
      session: 'receiver-owned-mcp-session',
      subject: 'mcp-receiver-owner',
      kind: 'mcp-server',
    },
    humanOversightApproverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
    agentIdentityRuntime: f.agentIdentityRuntime,
    ...overrides,
  };
}

module.exports = {
  FIXTURE_NOW_MS,
  fixture,
  identityRecord,
  identityRuntime,
  queueParams,
  operatorParams,
  runtimeOptions,
};
