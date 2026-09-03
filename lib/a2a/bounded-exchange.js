'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');

const { enforceExternalClientPackage } = require('../external-client-package-gate');
const { encodeJsonStableV1 } = require('../receipt/cryptographic-profile-contract');
const { verifyCryptographicEvidence } = require('../receipt/cryptographic-verification-adapter');
const { importPublicTrustReceipt } = require('../receipt/public-trust-receipt');
const { resolveTrustedKeyState } = require('../receipt/trusted-key-resolver');
const { validateInterAgentRouteReceipt } = require('./inter-agent-receipt-chain');

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

function block(reason) {
  return Object.freeze({ decision: 'block', reason });
}

function plain(value) {
  try {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactObject(value, keys) {
  if (!plain(value)) return false;
  try {
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string')
      || actual.sort().join('\0') !== [...keys].sort().join('\0')) return false;
    return actual.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
        && !descriptor.get && !descriptor.set;
    });
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES && value.trim() === value;
}

function canonicalInstant(value) {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function uniqueStrings(value, { allowEmpty = false, maxItems = MAX_LIST_ITEMS } = {}) {
  return Array.isArray(value)
    && value.length <= maxItems
    && (allowEmpty || value.length > 0)
    && value.every(nonEmpty)
    && new Set(value).size === value.length;
}

function snapshotUntrustedData(value) {
  try {
    if (containsProxy(value)) return null;
    const bytes = encodeJsonStableV1(value);
    if (bytes.length < 1 || bytes.length > MAX_EXCHANGE_BYTES) return null;
    const snapshot = JSON.parse(bytes.toString('utf8'));
    // Canonical JSON produces a detached, data-only structure. This makes a
    // later Proxy/getter mutation unable to alter what the verifier checked.
    return deepFreeze(snapshot);
  } catch {
    return null;
  }
}

function containsProxy(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (utilTypes.isProxy(value) || seen.has(value)) return utilTypes.isProxy(value);
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set
      || containsProxy(descriptor.value, seen)) return true;
  }
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(encodeJsonStableV1(value)).digest('hex');
}

function strictBase64(value, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === expectedBytes && bytes.toString('base64') === value ? bytes : null;
}

function strictBase64url(value, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === expectedBytes && bytes.toString('base64url') === value ? bytes : null;
}

function signatureShape(value) {
  return exactObject(value, SIGNATURE_KEYS)
    && value.algorithm === 'ed25519-v1'
    && nonEmpty(value.keyReference)
    && strictBase64url(value.value, 64) !== null;
}

function signingView(request) {
  const { signature: ignored, ...unsigned } = request;
  return { domainLabel: SIGNATURE_DOMAIN, request: unsigned };
}

function envelopeCoreView(request) {
  return {
    schemaVersion: request.schemaVersion,
    exchangeId: request.exchangeId,
    nonce: request.nonce,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    workspaceId: request.workspaceId,
    source: request.source,
    target: request.target,
    participants: request.participants,
    delegation: request.delegation,
    requestedAction: request.requestedAction,
    constraints: request.constraints,
    observation: request.observation,
    routeReceipt: request.routeReceipt,
  };
}

function delegationSigningView(hop) {
  const { signature: ignored, ...unsigned } = hop;
  return { domainLabel: DELEGATION_DOMAIN, delegation: unsigned };
}

/**
 * Translate a receiver authority's key entries into trusted-key resolver
 * records, or null if any entry's key bytes are not decodable.
 *
 * Extracted and exported for one reason: the registry (#1787) has to resolve
 * the same authority's keys, and a second reading of the same file would be a
 * second key authority -- the failure mode where the registry admits a key the
 * exchange would reject. Behaviour is unchanged; the caller below is the
 * original code path.
 */
function authorityTrustedKeyRecords(authority) {
  const records = authority.keys.map((entry) => ({
    keyReference: entry.keyReference,
    status: entry.status,
    expiresAt: entry.expiresAt,
    ...(entry.publicKeySpkiDerBase64 === null
      ? {}
      : { publicKeySpkiDer: strictBase64(entry.publicKeySpkiDerBase64, 44) }),
  }));
  if (records.some((record) => Object.hasOwn(record, 'publicKeySpkiDer')
    && record.publicKeySpkiDer === null)) return null;
  return records;
}

function resolveAuthorityKey(authority, keyReference, evaluationTime) {
  const records = authorityTrustedKeyRecords(authority);
  if (records === null) return null;
  const state = resolveTrustedKeyState({ keyReference, records, evaluationTime });
  return state.keyState === 'active' ? state.publicKeySpkiDer : null;
}

function verifySignature(authority, signature, message, evaluationTime) {
  if (!signatureShape(signature)) return false;
  const publicKeySpkiDer = resolveAuthorityKey(authority, signature.keyReference, evaluationTime);
  if (!publicKeySpkiDer) return false;
  let messageBytes;
  try {
    messageBytes = encodeJsonStableV1(message);
  } catch (_) {
    // A message the canonicalizer refuses -- unsupported shape, or past a
    // traversal budget (#765) -- is a message this verifier cannot have
    // checked. That is an unverified signature, not an exception to raise at
    // whoever called us.
    return false;
  }
  const result = verifyCryptographicEvidence({
    algorithm: 'ed25519-v1',
    messageBytes,
    publicKeySpkiDer,
    signatureBytes: strictBase64url(signature.value, 64),
  });
  return result.cryptographicState === 'valid';
}

function validateAuthority(authority) {
  if (!exactObject(authority, AUTHORITY_KEYS)
      || !Array.isArray(authority.identities) || authority.identities.length < 2
      || authority.identities.length > MAX_LIST_ITEMS
      || !Array.isArray(authority.keys) || authority.keys.length < 2
      || authority.keys.length > MAX_LIST_ITEMS
      || !Array.isArray(authority.receiptBindings) || authority.receiptBindings.length < 1
      || authority.receiptBindings.length > MAX_LIST_ITEMS
      || !Array.isArray(authority.receiptTrustedKeyRecords)
      || authority.receiptTrustedKeyRecords.length < 1
      || authority.receiptTrustedKeyRecords.length > MAX_LIST_ITEMS
      || !canonicalInstant(authority.evaluationTime)
      || !nonEmpty(authority.authorityId)
      || !exactObject(authority.expectedTarget, EXPECTED_TARGET_KEYS)
      || !nonEmpty(authority.expectedTarget.agentId)
      || !nonEmpty(authority.expectedTarget.identityRef)
      || !SHA256.test(authority.expectedTarget.identityHash)
      || !nonEmpty(authority.expectedTarget.workspaceId)) return false;
  const identityRefs = new Set();
  const identityIds = new Set();
  for (const entry of authority.identities) {
    if (!exactObject(entry, AUTHORITY_IDENTITY_KEYS)
        || !nonEmpty(entry.ref) || !nonEmpty(entry.keyReference)
        || !plain(entry.record) || identityRefs.has(entry.ref)
        || identityIds.has(entry.record.agent_id)
        || !uniqueStrings(entry.allowedPackageIds)) return false;
    identityRefs.add(entry.ref);
    identityIds.add(entry.record.agent_id);
  }
  const keyRefs = new Set();
  for (const entry of authority.keys) {
    if (!exactObject(entry, AUTHORITY_KEY_KEYS) || !nonEmpty(entry.keyReference)
        || !['active', 'unknown', 'revoked', 'expired', 'unavailable', 'malformed'].includes(entry.status)
        || !canonicalInstant(entry.expiresAt) || keyRefs.has(entry.keyReference)
        || (entry.publicKeySpkiDerBase64 !== null
          && strictBase64(entry.publicKeySpkiDerBase64, 44) === null)) return false;
    keyRefs.add(entry.keyReference);
  }
  const receiptBindingIds = new Set();
  for (const entry of authority.receiptBindings) {
    if (!exactObject(entry, RECEIPT_BINDING_KEYS)
        || !SHA256.test(entry.publicReceiptId)
        || !SHA256.test(entry.expectedInternalReceiptHash)
        || !SHA256.test(entry.expectedBundleHash)
        || !nonEmpty(entry.keyId) || entry.purpose !== 'a2a-public-trust-receipt'
        || receiptBindingIds.has(entry.publicReceiptId)) return false;
    receiptBindingIds.add(entry.publicReceiptId);
  }
  const receiptKeyRefs = new Set();
  for (const entry of authority.receiptTrustedKeyRecords) {
    if (!exactObject(entry, RECEIPT_TRUSTED_KEY_KEYS)
        || !nonEmpty(entry.keyReference)
        || !['active', 'unknown', 'revoked', 'expired', 'unavailable', 'malformed'].includes(entry.status)
        || !canonicalInstant(entry.expiresAt)
        || entry.purpose !== 'a2a-public-trust-receipt'
        || receiptKeyRefs.has(entry.keyReference)
        || (entry.publicKeySpkiDerBase64 !== null
          && strictBase64(entry.publicKeySpkiDerBase64, 44) === null)) return false;
    receiptKeyRefs.add(entry.keyReference);
  }
  if (authority.receiptBindings.some((binding) => !receiptKeyRefs.has(binding.keyId))
      || [...receiptKeyRefs].some((keyReference) => keyRefs.has(keyReference))) return false;
  return true;
}

function validateIdentityRecord(record, evaluationTime) {
  if (!exactObject(record, IDENTITY_REQUIRED_KEYS)) return false;
  for (const key of ['agent_id', 'agent_type', 'display_name', 'owner_actor_id',
    'workspace_id', 'risk_tier', 'trust_tier', 'policy_version',
    'verification_status', 'expected_status']) {
    if (!nonEmpty(record[key])) return false;
  }
  for (const key of ['delegation_scope', 'allowed_tools', 'allowed_memory_scopes',
    'allowed_connectors', 'receipt_refs', 'provenance_refs', 'audit_requirements']) {
    if (!uniqueStrings(record[key], { allowEmpty: key !== 'delegation_scope' })) return false;
  }
  if (!uniqueStrings(record.delegation_chain)) return false;
  if (!Object.hasOwn(RISK_ORDER, record.risk_tier)
      || !canonicalInstant(record.issued_at) || !canonicalInstant(record.expires_at)
      || Date.parse(record.issued_at) > Date.parse(evaluationTime)
      || Date.parse(record.expires_at) <= Date.parse(evaluationTime)
      || record.revoked_at !== null || record.revocation_reason !== null
      || ![null, ...record.delegation_chain].includes(record.parent_agent_id)
      || !['valid', 'registered'].includes(record.verification_status)
      || record.expected_status !== 'valid' || record.expected_reason_code !== null) return false;
  return true;
}

function resolveParticipants(request, authority, evaluationTime) {
  if (!Array.isArray(request.participants) || request.participants.length < 2
      || request.participants.length > MAX_LIST_ITEMS) return null;
  const byId = new Map();
  for (const party of request.participants) {
    if (!exactObject(party, PARTY_KEYS) || !nonEmpty(party.agentId)
        || !nonEmpty(party.identityRef) || !SHA256.test(party.identityHash)
        || byId.has(party.agentId)) return null;
    const matches = authority.identities.filter((entry) => entry.ref === party.identityRef);
    if (matches.length !== 1) return null;
    const entry = matches[0];
    if (!validateIdentityRecord(entry.record, evaluationTime)
        || entry.record.agent_id !== party.agentId
        || canonicalHash(entry.record) !== party.identityHash
        || entry.record.workspace_id !== request.workspaceId) return null;
    byId.set(party.agentId, { party, entry });
  }
  if (!byId.has(request.source.agentId) || !byId.has(request.target.agentId)) return null;
  return byId;
}

function subset(child, parent) {
  const parentSet = new Set(parent);
  return child.every((value) => parentSet.has(value));
}

function validateDelegation(request, participants, authority, evaluationTime) {
  const delegation = request.delegation;
  if (!exactObject(delegation, DELEGATION_KEYS)
      || !uniqueStrings(delegation.chain) || delegation.chain.length > 16
      || request.participants.length !== delegation.chain.length
      || !Array.isArray(delegation.hops)
      || delegation.hops.length !== delegation.chain.length - 1
      || delegation.chain[0] !== request.source.agentId
      || delegation.chain.at(-1) !== request.target.agentId) return 'delegation_chain_invalid';

  const rootIdentity = participants.get(request.source.agentId)?.entry.record;
  if (!rootIdentity || rootIdentity.parent_agent_id !== null
      || JSON.stringify(rootIdentity.delegation_chain) !== JSON.stringify([request.source.agentId])) {
    return 'delegation_chain_invalid';
  }

  let previousHash = null;
  let previousHop = null;
  for (let index = 0; index < delegation.hops.length; index += 1) {
    const hop = delegation.hops[index];
    if (!exactObject(hop, HOP_KEYS) || !nonEmpty(hop.delegatorId)
        || !nonEmpty(hop.delegateId) || !nonEmpty(hop.workspaceId)
        || !uniqueStrings(hop.scope) || !nonEmpty(hop.target)
        || !Object.hasOwn(RISK_ORDER, hop.maxRiskTier)
        || !uniqueStrings(hop.allowedTools) || !uniqueStrings(hop.allowedConnectors)
        || !canonicalInstant(hop.expiresAt)
        || !signatureShape(hop.signature)) return 'delegation_invalid';
    if (hop.delegatorId !== delegation.chain[index]
        || hop.delegateId !== delegation.chain[index + 1]
        || hop.workspaceId !== request.workspaceId
        || hop.parentDelegationHash !== previousHash) return 'delegation_chain_invalid';
    const delegator = participants.get(hop.delegatorId);
    const delegate = participants.get(hop.delegateId);
    if (!delegator || !delegate
        || hop.keyReference !== delegator.entry.keyReference
        || hop.signature.keyReference !== delegator.entry.keyReference
        || !verifySignature(authority, hop.signature, delegationSigningView(hop), evaluationTime)) {
      return 'delegation_signature_invalid';
    }
    const delegatorIdentity = delegator.entry.record;
    const delegateIdentity = delegate.entry.record;
    const expectedChain = delegation.chain.slice(0, index + 2);
    if (delegateIdentity.parent_agent_id !== hop.delegatorId
        || JSON.stringify(delegateIdentity.delegation_chain) !== JSON.stringify(expectedChain)
        || !subset(hop.scope, delegatorIdentity.delegation_scope)
        || !subset(hop.scope, delegateIdentity.delegation_scope)
        || !subset(hop.allowedTools, delegatorIdentity.allowed_tools)
        || !subset(hop.allowedTools, delegateIdentity.allowed_tools)
        || !subset(hop.allowedConnectors, delegatorIdentity.allowed_connectors)
        || !subset(hop.allowedConnectors, delegateIdentity.allowed_connectors)
        || RISK_ORDER[hop.maxRiskTier] > RISK_ORDER[delegatorIdentity.risk_tier]
        || RISK_ORDER[hop.maxRiskTier] > RISK_ORDER[delegateIdentity.risk_tier]) {
      return 'delegation_scope_escalation';
    }
    if (previousHop && (!subset(hop.scope, previousHop.scope)
      || !subset(hop.allowedTools, previousHop.allowedTools)
      || !subset(hop.allowedConnectors, previousHop.allowedConnectors)
      || hop.target !== previousHop.target
      || RISK_ORDER[hop.maxRiskTier] > RISK_ORDER[previousHop.maxRiskTier]
      || Date.parse(hop.expiresAt) > Date.parse(previousHop.expiresAt))) {
      return 'delegation_scope_escalation';
    }
    if (Date.parse(hop.expiresAt) <= Date.parse(evaluationTime)
        || Date.parse(hop.expiresAt) > Date.parse(delegatorIdentity.expires_at)
        || Date.parse(hop.expiresAt) > Date.parse(delegateIdentity.expires_at)) {
      return 'delegation_expired';
    }
    previousHash = canonicalHash(hop);
    previousHop = hop;
  }
  return null;
}

function validateEvidence(request, authority, evaluationTime) {
  const evidence = request.evidence;
  if (!exactObject(evidence, EVIDENCE_KEYS) || !SHA256.test(evidence.actionHash)
      || !SHA256.test(evidence.receiptHash) || !SHA256.test(evidence.packageHash)
      || canonicalHash(request.requestedAction) !== evidence.actionHash) return 'evidence_action_invalid';
  if (!plain(evidence.receipt) || canonicalHash(evidence.receipt) !== evidence.receiptHash) {
    return 'evidence_receipt_invalid';
  }
  if (!plain(evidence.package) || canonicalHash(evidence.package) !== evidence.packageHash) {
    return 'evidence_package_invalid';
  }
  if (!Array.isArray(evidence.evidenceRefs) || evidence.evidenceRefs.length !== 3
      || evidence.evidenceRefs.some((reference) => !exactObject(reference, EVIDENCE_REF_KEYS)
        || !nonEmpty(reference.kind) || !SHA256.test(reference.digest)
        || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1
        || reference.bytes > MAX_EXCHANGE_BYTES)
      || evidence.evidenceRefs.reduce((total, reference) => total + reference.bytes, 0)
        > MAX_EXCHANGE_BYTES) return 'evidence_refs_invalid';
  const references = new Map(evidence.evidenceRefs.map((reference) => [reference.kind, reference]));
  if (references.size !== 3 || !references.has('requested-action')
      || !references.has('public-trust-receipt') || !references.has('huqan-package')
      || references.get('requested-action').digest !== evidence.actionHash
      || references.get('requested-action').bytes !== encodeJsonStableV1(request.requestedAction).length
      || references.get('public-trust-receipt').digest !== evidence.receiptHash
      || references.get('public-trust-receipt').bytes !== encodeJsonStableV1(evidence.receipt).length
      || references.get('huqan-package').digest !== evidence.packageHash
      || references.get('huqan-package').bytes !== encodeJsonStableV1(evidence.package).length) {
    return 'evidence_refs_invalid';
  }
  if (!exactObject(evidence.packageSignature, PACKAGE_SIGNATURE_KEYS)
      || evidence.packageSignature.algorithm !== 'ed25519'
      || evidence.packageSignature.keyId !== request.source.agentId
      || strictBase64(evidence.packageSignature.value, 64) === null) return 'evidence_package_invalid';
  const sourceIdentity = authority.identities.find((entry) => entry.ref === request.source.identityRef);
  const sourceKey = sourceIdentity
    ? resolveAuthorityKey(authority, sourceIdentity.keyReference, evaluationTime)
    : null;
  if (!sourceKey) return 'evidence_package_invalid';
  if (!sourceIdentity.allowedPackageIds.includes(evidence.package.manifest?.packageId)) {
    return 'evidence_package_authority_invalid';
  }
  let packageGate;
  try {
    packageGate = enforceExternalClientPackage({
      identity: { subject: request.source.agentId, kind: 'a2a-agent' },
      workspaceId: request.workspaceId,
      package: evidence.package,
      signature: evidence.packageSignature,
    }, {
      expectedWorkspaceId: request.workspaceId,
      expectedPackageId: evidence.package.manifest.packageId,
      trustedKeys: {
        [request.source.agentId]: {
          publicKey: crypto.createPublicKey({ key: sourceKey, format: 'der', type: 'spki' }),
          workspaceId: request.workspaceId,
          packageIds: sourceIdentity?.allowedPackageIds || [],
          identitySubjects: [request.source.agentId],
          identityKinds: ['a2a-agent'],
        },
      },
    });
  } catch {
    return 'evidence_package_invalid';
  }
  if (!packageGate.ok || packageGate.packageHash !== evidence.packageHash
      || evidence.package.manifest.format !== 'huqan-package'
      || evidence.package.manifest.formatVersion !== '0.2'
      || evidence.package.manifest.protocolVersion !== '0.1'
      || evidence.package.manifest.workspaceId !== request.workspaceId) return 'evidence_package_invalid';
  const source = evidence.package.manifest.source;
  if (!exactObject(source, ['type', ...PACKAGE_BINDING_KEYS])
      || source.type !== 'a2a-conformance'
      || source.exchangeId !== request.exchangeId
      || source.workspaceId !== request.workspaceId
      || source.sourceIdentityHash !== request.source.identityHash
      || source.targetIdentityHash !== request.target.identityHash
      || source.envelopeHash !== canonicalHash(envelopeCoreView(request))
      || source.receiptHash !== evidence.receiptHash
       || !SHA256.test(source.internalReceiptHash)
       || !SHA256.test(source.bundleHash)) return 'evidence_package_binding_invalid';
  const receiptBinding = authority.receiptBindings.filter(
    (entry) => entry.publicReceiptId === evidence.receipt.publicReceiptId,
  );
  if (receiptBinding.length !== 1
      || receiptBinding[0].expectedInternalReceiptHash !== source.internalReceiptHash
      || receiptBinding[0].expectedBundleHash !== source.bundleHash
      || receiptBinding[0].purpose !== 'a2a-public-trust-receipt'
      || evidence.receipt.integrity?.signature?.keyId !== receiptBinding[0].keyId) {
    return 'evidence_receipt_authority_invalid';
  }
  const trustedKeyRecords = authority.receiptTrustedKeyRecords.map((entry) => ({
    keyReference: entry.keyReference,
    status: entry.status,
    expiresAt: entry.expiresAt,
    ...(entry.publicKeySpkiDerBase64 === null ? {} : {
      publicKeySpkiDer: strictBase64(entry.publicKeySpkiDerBase64, 44),
    }),
  }));
  const imported = importPublicTrustReceipt(encodeJsonStableV1(evidence.receipt), {
    // These values originate in a package that the receiver just signature-
    // verified, then must also match its out-of-band receipt binding above.
    expectedInternalReceiptHash: source.internalReceiptHash,
    expectedBundleHash: source.bundleHash,
    trustedKeyRecords,
    evaluationTime,
  });
  if (!imported.ok || imported.status !== 'verified') return 'evidence_receipt_invalid';
  const routeReceiptFailure = validateInterAgentRouteReceipt(request, sourceIdentity.record);
  if (routeReceiptFailure) return routeReceiptFailure;
  return null;
}

function replayKeyMaterial(request, authority) {
  return {
    domainLabel: 'HUQAN/V5/D6/A2A-REPLAY/v1',
    // The complete signed request carries all exchange material. The receiver
    // identifier is stable policy-domain separation; mutable clock/key status
    // must not make an already-reserved request executable again after restart.
    receiverAuthorityId: authority.authorityId,
    request,
  };
}

function evaluateBoundedExchange(input) {
  try {
    const consumerKeys = ['request', 'authority', 'evaluationTime', 'replayReserve', 'effect'];
    if (utilTypes.isProxy(input)
      || (!exactObject(input, consumerKeys) && !exactObject(input, [...consumerKeys, 'admission']))) {
      return block('consumer_invalid');
    }
    const request = snapshotUntrustedData(input.request);
    const authority = snapshotUntrustedData(input.authority);
    const evaluationTime = input.evaluationTime;
    const replayReserve = input.replayReserve;
    const effect = input.effect;
    const admission = input.admission;
    if (!request || !authority) return block('exchange_shape_invalid');
    if (!canonicalInstant(evaluationTime) || !validateAuthority(authority)) return block('authority_invalid');
    if (!exactObject(request, REQUEST_KEYS) || request.schemaVersion !== SCHEMA_VERSION
        || !nonEmpty(request.exchangeId) || !nonEmpty(request.nonce)
        || !canonicalInstant(request.issuedAt) || !canonicalInstant(request.expiresAt)
        || !nonEmpty(request.workspaceId)
        || !exactObject(request.source, PARTY_KEYS) || !exactObject(request.target, PARTY_KEYS)
        || !exactObject(request.requestedAction, ACTION_KEYS)
        || !exactObject(request.constraints, CONSTRAINT_KEYS)
        || !exactObject(request.observation, OBSERVATION_KEYS)
        || !exactObject(request.evidence, EVIDENCE_KEYS)
        || !signatureShape(request.signature)) return block('exchange_shape_invalid');
    if (Date.parse(request.issuedAt) > Date.parse(evaluationTime)
        || Date.parse(request.expiresAt) <= Date.parse(evaluationTime)) return block('exchange_expired');
    const participants = resolveParticipants(request, authority, evaluationTime);
    if (!participants) return block('identity_invalid');
    if (request.source.agentId === request.target.agentId
        || JSON.stringify(request.source) !== JSON.stringify(request.participants[0])
        || JSON.stringify(request.target) !== JSON.stringify(request.participants.at(-1))
        || request.target.agentId !== authority.expectedTarget.agentId
        || request.target.identityRef !== authority.expectedTarget.identityRef
        || request.target.identityHash !== authority.expectedTarget.identityHash
        || request.workspaceId !== authority.expectedTarget.workspaceId) {
      return block('identity_binding_invalid');
    }
    const delegationFailure = validateDelegation(request, participants, authority, evaluationTime);
    if (delegationFailure) return block(delegationFailure);
    const finalHop = request.delegation.hops.at(-1);
    const action = request.requestedAction;
    const constraints = request.constraints;
    const observation = request.observation;
    if (!Object.hasOwn(RISK_ORDER, action.riskTier)
        || !nonEmpty(action.capability) || !nonEmpty(action.target)
        || !nonEmpty(action.tool) || !nonEmpty(action.connector)
        || !SHA256.test(action.parametersHash)
        || !Object.hasOwn(RISK_ORDER, constraints.maxRiskTier)
        || !uniqueStrings(constraints.allowedTools) || !uniqueStrings(constraints.allowedConnectors)
        || !SHA256.test(observation.observedActionHash)
        || !Object.hasOwn(RISK_ORDER, observation.observedRiskTier)
        || !uniqueStrings(observation.usedTools) || !uniqueStrings(observation.usedConnectors)
        || !canonicalInstant(observation.observedAt) || !SHA256.test(observation.effectHash)
        || observation.observedActionHash !== request.evidence.actionHash
        || Date.parse(observation.observedAt) > Date.parse(evaluationTime)
        || Date.parse(observation.observedAt) >= Date.parse(request.expiresAt)
        || !finalHop.scope.includes(action.capability) || action.target !== finalHop.target
        || RISK_ORDER[constraints.maxRiskTier] > RISK_ORDER[finalHop.maxRiskTier]
        || RISK_ORDER[action.riskTier] > RISK_ORDER[constraints.maxRiskTier]
        || !subset(constraints.allowedTools, finalHop.allowedTools)
        || !subset(constraints.allowedConnectors, finalHop.allowedConnectors)
        || !constraints.allowedTools.includes(action.tool)
        || !constraints.allowedConnectors.includes(action.connector)
        || RISK_ORDER[observation.observedRiskTier] > RISK_ORDER[constraints.maxRiskTier]
        || !subset(observation.usedTools, constraints.allowedTools)
        || !subset(observation.usedConnectors, constraints.allowedConnectors)
        || observation.usedTools.length !== 1 || observation.usedTools[0] !== action.tool
        || observation.usedConnectors.length !== 1 || observation.usedConnectors[0] !== action.connector
        || Date.parse(request.expiresAt) > Date.parse(finalHop.expiresAt)) {
      return block('constraints_exceeded');
    }
    const evidenceFailure = validateEvidence(request, authority, evaluationTime);
    if (evidenceFailure) return block(evidenceFailure);
    const sourceAuthority = participants.get(request.source.agentId).entry;
    if (request.signature.keyReference !== sourceAuthority.keyReference
        || !verifySignature(authority, request.signature, signingView(request), evaluationTime)) {
      return block('exchange_signature_invalid');
    }
    // Production receivers may add a local action gate after every caller-
    // supplied byte has been authenticated, but before the replay reservation
    // or effect. A non-allow decision is therefore fail-closed without turning
    // a rejected action into an at-most-once reservation.
    if (admission !== undefined) {
      if (typeof admission !== 'function') return block('consumer_invalid');
      const admissionDecision = admission(request);
      if (!plain(admissionDecision)
          || !['allow', 'review', 'block', 'dry_run_only'].includes(admissionDecision.decision)
          || !nonEmpty(admissionDecision.reason)) return block('admission_invalid');
      if (admissionDecision.decision !== 'allow') {
        return Object.freeze({
          decision: admissionDecision.decision,
          reason: admissionDecision.reason,
          firewall: admissionDecision,
        });
      }
    }
    if (typeof replayReserve !== 'function' || typeof effect !== 'function') return block('consumer_invalid');
    const replayDigest = canonicalHash(replayKeyMaterial(request, authority));
    const reservation = replayReserve({ replayKey: replayDigest });
    if (!plain(reservation) || reservation.reserved !== true
        || Object.keys(reservation).length !== 1) return block('replay_detected');
    const effectResult = effect();
    return Object.freeze({ decision: 'allow', reason: 'ok', effect: effectResult });
  } catch {
    return block('verification_failed');
  }
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  SIGNATURE_DOMAIN,
  DELEGATION_DOMAIN,
  canonicalHash,
  signingView,
  envelopeCoreView,
  delegationSigningView,
  authorityTrustedKeyRecords,
  evaluateBoundedExchange,
});
