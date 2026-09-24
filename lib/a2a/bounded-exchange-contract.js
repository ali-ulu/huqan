'use strict';

// #2158: the exchange's versioned contract -- schema and signature domains,
// size bounds, risk order and the exact key set of every object.

const SCHEMA_VERSION = 'v5-d6-a2a-exchange-v1';
const SIGNATURE_DOMAIN = 'HUQAN/V5/D6/A2A-EXCHANGE/v1';
const DELEGATION_DOMAIN = 'HUQAN/V5/D6/A2A-DELEGATION/v1';
const SHA256 = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const MAX_EXCHANGE_BYTES = 1024 * 1024;
const MAX_STRING_BYTES = 1024;
const MAX_LIST_ITEMS = 16;

const REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'exchangeId', 'nonce', 'issuedAt', 'expiresAt', 'workspaceId',
  'source', 'target', 'participants', 'delegation', 'requestedAction',
  'constraints', 'observation', 'routeReceipt', 'evidence', 'signature',
]);
const PARTY_KEYS = Object.freeze(['agentId', 'identityRef', 'identityHash']);
const ACTION_KEYS = Object.freeze([
  'capability', 'target', 'riskTier', 'tool', 'connector', 'parametersHash',
]);
const CONSTRAINT_KEYS = Object.freeze([
  'maxRiskTier', 'allowedTools', 'allowedConnectors',
]);
const OBSERVATION_KEYS = Object.freeze([
  'observedActionHash', 'observedRiskTier', 'usedTools', 'usedConnectors',
  'observedAt', 'effectHash',
]);
const DELEGATION_KEYS = Object.freeze(['chain', 'hops']);
const HOP_KEYS = Object.freeze([
  'delegatorId', 'delegateId', 'workspaceId', 'scope', 'target', 'maxRiskTier',
  'allowedTools', 'allowedConnectors', 'expiresAt', 'parentDelegationHash',
  'keyReference', 'signature',
]);
const EVIDENCE_KEYS = Object.freeze([
  'actionHash', 'receipt', 'receiptHash', 'package', 'packageHash',
  'packageSignature', 'evidenceRefs',
]);
const EVIDENCE_REF_KEYS = Object.freeze(['kind', 'digest', 'bytes']);
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'keyReference', 'value']);
const PACKAGE_SIGNATURE_KEYS = Object.freeze(['algorithm', 'keyId', 'value']);
const AUTHORITY_KEYS = Object.freeze([
  'identities', 'keys', 'expectedTarget', 'receiptBindings', 'receiptTrustedKeyRecords', 'evaluationTime', 'authorityId',
]);
const AUTHORITY_IDENTITY_KEYS = Object.freeze(['ref', 'keyReference', 'record', 'allowedPackageIds']);
const AUTHORITY_KEY_KEYS = Object.freeze([
  'keyReference', 'status', 'expiresAt', 'publicKeySpkiDerBase64',
]);
const EXPECTED_TARGET_KEYS = Object.freeze(['agentId', 'identityRef', 'identityHash', 'workspaceId']);
const RECEIPT_BINDING_KEYS = Object.freeze([
  'publicReceiptId', 'expectedInternalReceiptHash', 'expectedBundleHash', 'keyId', 'purpose',
]);
const RECEIPT_TRUSTED_KEY_KEYS = Object.freeze([
  'keyReference', 'status', 'expiresAt', 'publicKeySpkiDerBase64', 'purpose',
]);
const IDENTITY_REQUIRED_KEYS = Object.freeze([
  'agent_id', 'agent_type', 'display_name', 'owner_actor_id', 'workspace_id',
  'delegation_scope', 'allowed_tools', 'allowed_memory_scopes',
  'allowed_connectors', 'risk_tier', 'trust_tier', 'policy_version', 'issued_at',
  'expires_at', 'revoked_at', 'revocation_reason', 'parent_agent_id',
  'delegation_chain', 'receipt_refs', 'provenance_refs', 'audit_requirements',
  'verification_status', 'expected_status', 'expected_reason_code',
]);
const PACKAGE_BINDING_KEYS = Object.freeze([
  'exchangeId', 'workspaceId', 'sourceIdentityHash', 'targetIdentityHash',
  'envelopeHash', 'receiptHash', 'internalReceiptHash', 'bundleHash',
]);

module.exports = {
  ACTION_KEYS,
  AUTHORITY_IDENTITY_KEYS,
  AUTHORITY_KEYS,
  AUTHORITY_KEY_KEYS,
  CONSTRAINT_KEYS,
  DELEGATION_DOMAIN,
  DELEGATION_KEYS,
  EVIDENCE_KEYS,
  EVIDENCE_REF_KEYS,
  EXPECTED_TARGET_KEYS,
  HOP_KEYS,
  IDENTITY_REQUIRED_KEYS,
  INSTANT,
  MAX_EXCHANGE_BYTES,
  MAX_LIST_ITEMS,
  MAX_STRING_BYTES,
  OBSERVATION_KEYS,
  PACKAGE_BINDING_KEYS,
  PACKAGE_SIGNATURE_KEYS,
  PARTY_KEYS,
  RECEIPT_BINDING_KEYS,
  RECEIPT_TRUSTED_KEY_KEYS,
  REQUEST_KEYS,
  RISK_ORDER,
  SCHEMA_VERSION,
  SHA256,
  SIGNATURE_DOMAIN,
  SIGNATURE_KEYS,
};
