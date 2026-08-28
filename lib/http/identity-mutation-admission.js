'use strict';

const {
  composeReceiverOwnedIdentityClaim,
  evaluateAgentIdentity,
  snapshotAgentIdentityAuthority,
} = require('../agent-identity-runtime');
const { createMutationAdmission } = require('../mutation-admission');

const HTTP_INGEST_AUDIT_ACTION = 'graph.appendAuditEvent:ingest_approval';
const DEFAULT_IDENTITY_REF = 'identity:http-ingest-audit-writer';
const DEFAULT_RECEIVER_SUBJECT = 'huqan-http-server';

function buildDefaultHttpAuditIdentityConfig(workspaceId) {
  const normalizedWorkspaceId = String(workspaceId || 'default').trim() || 'default';
  const record = {
    agent_id: 'agent-http-ingest-audit-writer',
    agent_type: 'service',
    display_name: 'HUQAN HTTP ingest audit writer',
    owner_actor_id: DEFAULT_RECEIVER_SUBJECT,
    workspace_id: normalizedWorkspaceId,
    delegation_scope: [HTTP_INGEST_AUDIT_ACTION],
    allowed_tools: ['graph.appendAuditEvent'],
    allowed_memory_scopes: ['audit_only'],
    allowed_connectors: ['internal:graph'],
    risk_tier: 'low',
    trust_tier: 'system',
    policy_version: 'http-audit-identity-v1',
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    revoked_at: null,
    revocation_reason: null,
    parent_agent_id: null,
    delegation_chain: [],
    receipt_refs: [],
    provenance_refs: [],
    audit_requirements: ['trust_receipt'],
    verification_status: 'registered',
    expected_status: 'valid',
    expected_reason_code: null,
  };
  return {
    authority: snapshotAgentIdentityAuthority({
      workspaceId: normalizedWorkspaceId,
      identities: [{ ref: DEFAULT_IDENTITY_REF, record }],
      clock: () => Date.parse('2026-08-27T00:00:00.000Z'),
    }),
    identityRef: DEFAULT_IDENTITY_REF,
    receiver: {
      subject: DEFAULT_RECEIVER_SUBJECT,
      kind: 'http-ingest-audit-writer',
      workspaceId: normalizedWorkspaceId,
    },
    action: {
      capability: HTTP_INGEST_AUDIT_ACTION,
      target: `approval:${normalizedWorkspaceId}`,
      riskTier: 'low',
      tool: 'graph.appendAuditEvent',
      connector: 'internal:graph',
    },
  };
}

function blocked(reason, details = {}) {
  return {
    decision: 'block',
    allowed: false,
    reason,
    details,
  };
}

function buildHttpIdentityAdmissionContext({ workspaceId } = {}) {
  // These are real receiver-owned context objects, not `absent()` markers. The
  // admission evaluator below owns the authority and claim composition; these
  // fields satisfy the universal seam without letting the writer invent a
  // caller-provided identity claim.
  return {
    workspaceId,
    action: HTTP_INGEST_AUDIT_ACTION,
    identityClaim: { source: 'http-agent-identity-runtime' },
    delegationContext: { source: 'http-agent-identity-runtime' },
    connectorContext: { source: 'http-agent-identity-runtime' },
  };
}

function createHttpIdentityMutationAdmission({ getConfig } = {}) {
  if (typeof getConfig !== 'function') {
    throw new TypeError('HTTP identity config resolver is required');
  }

  return createMutationAdmission({
    identityEvaluator(context) {
      const configured = getConfig();
      const config = configured || buildDefaultHttpAuditIdentityConfig(context.workspaceId);
      if (!config || typeof config !== 'object') {
        return blocked('identity.authority_required');
      }
      const authority = config.authority;
      const identityRef = config.identityRef;
      const receiverConfig = config.receiver;
      const actionConfig = config.action;
      if (!authority || typeof identityRef !== 'string' || !receiverConfig || !actionConfig) {
        return blocked('identity.authority_invalid');
      }

      const receiver = {
        subject: receiverConfig.subject,
        kind: receiverConfig.kind || 'http-ingest-approval',
        workspaceId: receiverConfig.workspaceId || context.workspaceId,
      };
      const composition = composeReceiverOwnedIdentityClaim({
        authority,
        identityRef,
        receiver,
      });
      if (!composition || composition.allowed !== true) return composition || blocked('identity.evaluation_failed');

      const action = {
        capability: actionConfig.capability,
        target: actionConfig.target || `approval:${context.workspaceId}`,
        riskTier: actionConfig.riskTier,
        tool: actionConfig.tool || 'http.ingest',
        connector: actionConfig.connector || 'http:ingest',
      };
      return evaluateAgentIdentity({
        authority,
        claim: composition.claim,
        action,
      });
    },
  });
}

module.exports = Object.freeze({
  HTTP_INGEST_AUDIT_ACTION,
  buildDefaultHttpAuditIdentityConfig,
  buildHttpIdentityAdmissionContext,
  createHttpIdentityMutationAdmission,
});
