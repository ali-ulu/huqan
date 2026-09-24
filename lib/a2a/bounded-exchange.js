'use strict';

// Evaluates one bounded agent-to-agent exchange: every check blocks unless it
// can prove its part. Contract, value guards, signing, authority and the
// delegation/evidence checks live in bounded-exchange-*.js (#2158).

const { types: utilTypes } = require('node:util');
const { resolveParticipants, subset, validateAuthority } = require('./bounded-exchange-authority');
const { ACTION_KEYS, CONSTRAINT_KEYS, DELEGATION_DOMAIN, EVIDENCE_KEYS, OBSERVATION_KEYS, PARTY_KEYS, REQUEST_KEYS, RISK_ORDER, SCHEMA_VERSION, SHA256, SIGNATURE_DOMAIN } = require('./bounded-exchange-contract');
const { authorityTrustedKeyRecords, delegationSigningView, envelopeCoreView, signingView, verifySignature } = require('./bounded-exchange-signing');
const { validateDelegation, validateEvidence } = require('./bounded-exchange-validation');
const { block, canonicalHash, canonicalInstant, exactObject, nonEmpty, plain, signatureShape, snapshotUntrustedData, uniqueStrings } = require('./bounded-exchange-values');

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
