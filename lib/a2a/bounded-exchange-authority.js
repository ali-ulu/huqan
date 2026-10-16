'use strict';

// #2158: the authority record, identity records and the two participants
// they resolve to.

const { AUTHORITY_IDENTITY_KEYS, AUTHORITY_KEYS, AUTHORITY_KEY_KEYS, EXPECTED_TARGET_KEYS, IDENTITY_REQUIRED_KEYS, MAX_LIST_ITEMS, PARTY_KEYS, RECEIPT_BINDING_KEYS, RECEIPT_TRUSTED_KEY_KEYS, RISK_ORDER, SHA256 } = require('./bounded-exchange-contract');
const { canonicalHash, canonicalInstant, exactObject, nonEmpty, plain, strictBase64, uniqueStrings } = require('./bounded-exchange-values');

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

module.exports = {
  resolveParticipants,
  subset,
  validateAuthority,
  validateIdentityRecord,
};
