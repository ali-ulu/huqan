'use strict';

const crypto = require('node:crypto');

const { encodeJsonStableV1 } = require('../receipt/cryptographic-profile-contract');

const ROUTE_RECEIPT_SCHEMA_VERSION = 'v5-a2a-route-receipt-v1';
const HASH = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_TEXT_BYTES = 1024;
const ROUTE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'route_receipt_id', 'parent_receipt_id',
  'from_agent_id', 'to_agent_id', 'from_workspace_id', 'to_workspace_id',
  'action_ref', 'handoff_reason', 'delegation_scope', 'condition', 'timestamp',
  'policy_version', 'verification_status',
]);
const CONDITION_KEYS = Object.freeze([
  'max_risk_tier', 'allowed_tools', 'allowed_connectors', 'expires_at',
]);
const RECEIVER_RISK = Object.freeze({ allow: 0, review: 50, dry_run_only: 75, block: 100 });

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
}

function stringList(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 16
    && value.every(boundedText) && new Set(value).size === value.length;
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(encodeJsonStableV1(value)).digest('hex');
}

function routeReceiptProjection(receipt) {
  const { route_receipt_id: ignored, ...projection } = receipt;
  return projection;
}

function buildInterAgentRouteReceipt(request, parentReceipt, sourcePolicyVersion) {
  const finalHop = request.delegation.hops.at(-1);
  const routeReceipt = {
    schemaVersion: ROUTE_RECEIPT_SCHEMA_VERSION,
    route_receipt_id: '0'.repeat(64),
    parent_receipt_id: parentReceipt.publicReceiptId,
    from_agent_id: request.source.agentId,
    to_agent_id: request.target.agentId,
    from_workspace_id: request.workspaceId,
    to_workspace_id: request.workspaceId,
    action_ref: canonicalHash(request.requestedAction),
    handoff_reason: 'delegated_task',
    delegation_scope: Object.freeze([...finalHop.scope]),
    condition: Object.freeze({
      max_risk_tier: request.constraints.maxRiskTier,
      allowed_tools: Object.freeze([...request.constraints.allowedTools]),
      allowed_connectors: Object.freeze([...request.constraints.allowedConnectors]),
      expires_at: request.expiresAt,
    }),
    timestamp: request.issuedAt,
    policy_version: sourcePolicyVersion,
    verification_status: 'pending_receiver_verification',
  };
  routeReceipt.route_receipt_id = canonicalHash(routeReceiptProjection(routeReceipt));
  return Object.freeze(routeReceipt);
}

function validateInterAgentRouteReceipt(request, sourceIdentityRecord) {
  const receipt = request.routeReceipt;
  const parent = request.evidence?.receipt;
  const finalHop = request.delegation?.hops?.at(-1);
  if (!exact(receipt, ROUTE_RECEIPT_KEYS)
      || receipt.schemaVersion !== ROUTE_RECEIPT_SCHEMA_VERSION
      || !HASH.test(receipt.route_receipt_id)
      || canonicalHash(routeReceiptProjection(receipt)) !== receipt.route_receipt_id
      || !HASH.test(receipt.parent_receipt_id)
      || receipt.parent_receipt_id !== parent?.publicReceiptId
      || !boundedText(receipt.from_agent_id) || receipt.from_agent_id !== request.source?.agentId
      || !boundedText(receipt.to_agent_id) || receipt.to_agent_id !== request.target?.agentId
      || receipt.from_workspace_id !== request.workspaceId
      || receipt.to_workspace_id !== request.workspaceId
      || receipt.action_ref !== request.evidence?.actionHash
      || receipt.handoff_reason !== 'delegated_task'
      || !stringList(receipt.delegation_scope)
      || JSON.stringify(receipt.delegation_scope) !== JSON.stringify(finalHop?.scope)
      || !exact(receipt.condition, CONDITION_KEYS)
      || receipt.condition.max_risk_tier !== request.constraints?.maxRiskTier
      || JSON.stringify(receipt.condition.allowed_tools) !== JSON.stringify(request.constraints?.allowedTools)
      || JSON.stringify(receipt.condition.allowed_connectors) !== JSON.stringify(request.constraints?.allowedConnectors)
      || receipt.condition.expires_at !== request.expiresAt
      || !INSTANT.test(receipt.timestamp) || receipt.timestamp !== request.issuedAt
      || !boundedText(receipt.policy_version)
      || receipt.policy_version !== sourceIdentityRecord?.policy_version
      || receipt.verification_status !== 'pending_receiver_verification') {
    return 'route_receipt_invalid';
  }
  return null;
}

function aggregateInterAgentReceiptDecision(request, receiverDecision) {
  const disclosure = request.evidence.receipt.disclosure;
  const parentAllows = disclosure.decision === 'allow' && disclosure.verdict === 'allow';
  const receiverAllows = receiverDecision.decision === 'allow';
  const contradiction = parentAllows !== receiverAllows;
  const parentRisk = Number.isFinite(disclosure.riskScore)
    ? Math.min(100, Math.max(0, disclosure.riskScore))
    : 100;
  return Object.freeze({
    status: contradiction ? 'contradiction' : 'consistent',
    signal: contradiction ? 'cross_agent_decision_contradiction' : null,
    route_receipt_id: request.routeReceipt.route_receipt_id,
    parent_receipt_id: request.routeReceipt.parent_receipt_id,
    parent: Object.freeze({
      agent_id: request.routeReceipt.from_agent_id,
      decision: disclosure.decision,
      verdict: disclosure.verdict,
      risk_score: parentRisk,
    }),
    receiver: Object.freeze({
      agent_id: request.routeReceipt.to_agent_id,
      decision: receiverDecision.decision,
      reason: receiverDecision.reason,
      risk_score: RECEIVER_RISK[receiverDecision.decision] ?? 100,
    }),
    aggregate_risk_score: Math.max(
      parentRisk,
      RECEIVER_RISK[receiverDecision.decision] ?? 100,
    ),
  });
}

function evaluateInterAgentReceiptAdmission(request, receiverDecision) {
  const aggregation = aggregateInterAgentReceiptDecision(request, receiverDecision);
  const disclosure = request.evidence.receipt.disclosure;
  if (receiverDecision.decision === 'allow'
      && (disclosure.decision !== 'allow' || disclosure.verdict !== 'allow')) {
    return Object.freeze({
      decision: Object.freeze({
        decision: 'block',
        reason: 'PARENT_RECEIPT_NOT_AUTHORIZING',
        metadata: receiverDecision.metadata,
      }),
      aggregation,
    });
  }
  return Object.freeze({ decision: receiverDecision, aggregation });
}

module.exports = {
  ROUTE_RECEIPT_SCHEMA_VERSION,
  aggregateInterAgentReceiptDecision,
  buildInterAgentRouteReceipt,
  canonicalHash,
  evaluateInterAgentReceiptAdmission,
  validateInterAgentRouteReceipt,
};
