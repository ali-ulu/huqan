'use strict';

/**
 * The collector's counter-seal over what it received (#1882).
 *
 * #1861 and #1863 made a receipt prove where it came from and that it did not
 * change in transit. Both signatures are made with keys that live on the
 * audited host, so neither answers the question an audit actually asks: an
 * operator holding that key can edit the trail, re-sign it, and ship a clean
 * history where every signature verifies.
 *
 * A seal is the collector's own statement -- "I was handed exactly this, at
 * this time" -- signed with a key the sending host does not have. Two
 * properties make it worth more than a timestamp:
 *
 * - it covers `contentHash`, so the batch it attests to is a specific set of
 *   receipts and not merely a batch id;
 * - it names the previous seal for that tenant, so seals form a chain. Removing
 *   a stored batch leaves a break that a reader can find, rather than a gap
 *   that looks exactly like a quiet week.
 *
 * Honest boundary, kept here rather than in the pitch: this is third-party
 * evidence only when the collector is somewhere the agent's operator does not
 * administer. Both keys on one laptop means one person holds both ends, and
 * the seal then detects accidental corruption and nothing more.
 */

const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-receipt');

const COLLECTOR_SEAL_VERSION = 'huqan.collector-seal.v1';
const SIGNATURE_ALGORITHM = 'ed25519';
const GENESIS_SEAL_HASH = '';

/**
 * What the seal actually says. `receivedAt` is the collector's own clock and is
 * covered so it cannot be edited afterwards -- which is not the same as being
 * trustworthy on its own; a collector can still date its own seals, and
 * external time anchoring is deliberately a separate question.
 */
function canonicalSealPayload({ batchId, tenant, contentHash, count, receivedAt, previousSealHash }) {
  return {
    schemaVersion: COLLECTOR_SEAL_VERSION,
    batchId: String(batchId || ''),
    workspaceId: String(tenant?.workspaceId || ''),
    ownerActorId: String(tenant?.ownerActorId || ''),
    contentHash: String(contentHash || ''),
    count: Number.isInteger(count) ? count : -1,
    receivedAt: String(receivedAt || ''),
    previousSealHash: String(previousSealHash || GENESIS_SEAL_HASH),
  };
}

function sealHash(payload) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')}`;
}

/**
 * Seal a stored batch. Returns null on anything malformed so a collector that
 * was configured to seal can fail loudly rather than store an unsealed batch
 * that looks sealed.
 */
function signCollectorSeal(input, { keyReference, privateKeyPem } = {}) {
  if (typeof keyReference !== 'string' || !keyReference) return null;
  if (typeof privateKeyPem !== 'string' || !privateKeyPem) return null;
  const payload = canonicalSealPayload(input);
  if (!payload.batchId || !payload.contentHash || !payload.receivedAt) return null;
  try {
    const key = crypto.createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) return null;
    return Object.freeze({
      ...payload,
      keyId: keyReference,
      algorithm: SIGNATURE_ALGORITHM,
      sealHash: sealHash(payload),
      signature: crypto.sign(null, Buffer.from(stableStringify(payload), 'utf8'), key).toString('base64'),
    });
  } catch (_) {
    return null;
  }
}

/**
 * True only when this key made this seal over this statement. Recomputes the
 * hash rather than trusting the one on the seal: a stored `sealHash` is a
 * convenience for chaining, never an input to the decision.
 */
function verifyCollectorSeal(seal, publicKeyPem) {
  if (!seal || typeof seal !== 'object' || seal.schemaVersion !== COLLECTOR_SEAL_VERSION) return false;
  if (seal.algorithm !== SIGNATURE_ALGORITHM || typeof seal.signature !== 'string') return false;
  if (typeof publicKeyPem !== 'string' || !publicKeyPem) return false;
  const payload = canonicalSealPayload({
    batchId: seal.batchId,
    tenant: { workspaceId: seal.workspaceId, ownerActorId: seal.ownerActorId },
    contentHash: seal.contentHash,
    count: seal.count,
    receivedAt: seal.receivedAt,
    previousSealHash: seal.previousSealHash,
  });
  if (sealHash(payload) !== seal.sealHash) return false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) return false;
    const signature = Buffer.from(seal.signature, 'base64');
    if (signature.length !== 64) return false;
    return crypto.verify(null, Buffer.from(stableStringify(payload), 'utf8'), key, signature);
  } catch (_) {
    return false;
  }
}

/**
 * Walk a tenant's seals in stored order and report the first thing wrong.
 *
 * The chain is what turns deletion into something visible: a removed batch
 * leaves the next seal naming a predecessor that is no longer there. Reported
 * as a position and a reason rather than a bare false, because "seal 4 of 9
 * does not follow seal 3" is actionable and "invalid" is not.
 */
function verifyCollectorSealChain(seals, trustedKeys = {}) {
  const list = Array.isArray(seals) ? seals : [];
  let previousSealHash = GENESIS_SEAL_HASH;
  for (let index = 0; index < list.length; index += 1) {
    const seal = list[index];
    const publicKeyPem = seal && typeof seal.keyId === 'string' && Object.prototype.hasOwnProperty.call(trustedKeys, seal.keyId)
      ? trustedKeys[seal.keyId]
      : '';
    if (!publicKeyPem) {
      return { ok: false, index, batchId: seal?.batchId || '', reason: 'seal_key_not_trusted', checked: index };
    }
    if (!verifyCollectorSeal(seal, publicKeyPem)) {
      return { ok: false, index, batchId: seal.batchId || '', reason: 'seal_signature_invalid', checked: index };
    }
    if (String(seal.previousSealHash || GENESIS_SEAL_HASH) !== previousSealHash) {
      return { ok: false, index, batchId: seal.batchId || '', reason: 'seal_chain_broken', checked: index };
    }
    previousSealHash = seal.sealHash;
  }
  return { ok: true, checked: list.length, headSealHash: previousSealHash };
}

module.exports = Object.freeze({
  COLLECTOR_SEAL_VERSION,
  GENESIS_SEAL_HASH,
  canonicalSealPayload,
  sealHash,
  signCollectorSeal,
  verifyCollectorSeal,
  verifyCollectorSealChain,
});
