'use strict';

// #2158: what gets signed (envelope, core view, delegation hop) and how a
// signature is checked against the authority's trusted keys.

const { encodeJsonStableV1 } = require('../receipt/cryptographic-profile-contract');
const { verifyCryptographicEvidence } = require('../receipt/cryptographic-verification-adapter');
const { resolveTrustedKeyState } = require('../receipt/trusted-key-resolver');
const { DELEGATION_DOMAIN, SIGNATURE_DOMAIN } = require('./bounded-exchange-contract');
const { signatureShape, strictBase64, strictBase64url } = require('./bounded-exchange-values');

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

module.exports = {
  authorityTrustedKeyRecords,
  delegationSigningView,
  envelopeCoreView,
  resolveAuthorityKey,
  signingView,
  verifySignature,
};
