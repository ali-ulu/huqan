'use strict';

// #2158: the delegation chain and the evidence bundle; each returns a block
// reason, or null when it proved its part.

const crypto = require('node:crypto');
const { enforceExternalClientPackage } = require('../external-client-package-gate');
const { encodeJsonStableV1 } = require('../receipt/cryptographic-profile-contract');
const { importPublicTrustReceipt } = require('../receipt/public-trust-receipt');
const { validateInterAgentRouteReceipt } = require('./inter-agent-receipt-chain');
const { subset } = require('./bounded-exchange-authority');
const { DELEGATION_KEYS, EVIDENCE_KEYS, EVIDENCE_REF_KEYS, HOP_KEYS, MAX_EXCHANGE_BYTES, PACKAGE_BINDING_KEYS, PACKAGE_SIGNATURE_KEYS, RISK_ORDER, SHA256 } = require('./bounded-exchange-contract');
const { delegationSigningView, envelopeCoreView, resolveAuthorityKey, verifySignature } = require('./bounded-exchange-signing');
const { canonicalHash, canonicalInstant, exactObject, nonEmpty, plain, signatureShape, strictBase64, uniqueStrings } = require('./bounded-exchange-values');

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

module.exports = {
  validateDelegation,
  validateEvidence,
};
