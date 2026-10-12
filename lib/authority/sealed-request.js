'use strict';

// Operator decision requests sealed to the approval authority (#3860).
//
// A TOTP code proves the operator is present, but on its own it authorizes
// whatever request it travels in. A same-user impostor bound to the
// authority's port could relay the operator's session to the real service and
// spend the operator's code on a different approval. So the operator client
// never sends the code in clear: it seals the code together with the approval
// id, action hash and decision to the authority's X25519 key (ephemeral ECDH,
// HKDF-SHA256, AES-256-GCM with the approval id as associated data). Only the
// service can open it, and what it opens names the one action the operator
// chose. An impostor can drop or replay the sealed request, never re-point it.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const crypto = require('node:crypto');
const { stableStringify } = require('../hash-chain');
const { publicKeyOf, privateKeyOf } = require('./keys');

const SEALED_REQUEST_VERSION = 'huqan.authority.sealed.v1';
const HEX64 = /^[0-9a-f]{64}$/;
const CODE = /^\d{6}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TEXT = 512;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const X25519_BYTES = 32;

function assertRequest(request) {
  const { approvalId, actionHash, decision, reason, totp } = request || {};
  if (typeof approvalId !== 'string' || !approvalId || approvalId.length > MAX_TEXT) throw new TypeError('approvalId must be a bounded string');
  if (!HEX64.test(actionHash || '')) throw new TypeError('actionHash must be hex sha256');
  if (decision !== 'approved' && decision !== 'rejected') throw new TypeError('decision must be approved or rejected');
  if (typeof reason !== 'string' || reason.length > MAX_TEXT) throw new TypeError('reason must be a bounded string');
  if (typeof totp !== 'string' || !CODE.test(totp)) throw new TypeError('totp must be six digits');
  return { approvalId, actionHash, decision, reason, totp };
}

function generateSealKeyPair() {
  return crypto.generateKeyPairSync('x25519');
}

function x25519Public(raw) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
}

function rawOf(publicKey) {
  return publicKey.export({ format: 'jwk' }).x;
}

function deriveKey(shared, epk, recipient) {
  const salt = Buffer.concat([Buffer.from(epk, 'base64url'), Buffer.from(recipient, 'base64url')]);
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, SEALED_REQUEST_VERSION, 32));
}

function associatedData(approvalId) {
  return Buffer.from(stableStringify({ v: SEALED_REQUEST_VERSION, approvalId }), 'utf8');
}

function sealDecisionRequest(request, recipientPublicKey) {
  const clean = assertRequest(request);
  const recipient = publicKeyOf(recipientPublicKey, 'x25519');
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const epk = rawOf(ephemeral.publicKey);
  const key = deriveKey(crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), epk, rawOf(recipient));
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(clean.approvalId));
  const ct = Buffer.concat([cipher.update(stableStringify(clean), 'utf8'), cipher.final()]);
  return { v: SEALED_REQUEST_VERSION, approvalId: clean.approvalId, epk, nonce: nonce.toString('base64url'),
    ct: ct.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

function decodedLength(text) {
  return typeof text === 'string' && B64URL.test(text) ? Buffer.from(text, 'base64url').length : -1;
}

function wellFormed(sealed) {
  return Boolean(sealed) && typeof sealed === 'object' && sealed.v === SEALED_REQUEST_VERSION
    && typeof sealed.approvalId === 'string' && decodedLength(sealed.epk) === X25519_BYTES
    && decodedLength(sealed.nonce) === NONCE_BYTES && decodedLength(sealed.tag) === TAG_BYTES && decodedLength(sealed.ct) > 0;
}

/**
 * @returns {{ok: true, request: object} | {ok: false, code: 'malformed'|'binding_mismatch'|'unsealable'}}
 */
function openDecisionRequest(sealed, recipientPrivateKey, { approvalId }) {
  if (!wellFormed(sealed)) return { ok: false, code: 'malformed' };
  if (sealed.approvalId !== approvalId) return { ok: false, code: 'binding_mismatch' };
  try {
    const privateKey = privateKeyOf(recipientPrivateKey, 'x25519');
    const recipient = rawOf(publicKeyOf(privateKey, 'x25519'));
    const key = deriveKey(crypto.diffieHellman({ privateKey, publicKey: x25519Public(sealed.epk) }), sealed.epk, recipient);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64url'),
      { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(sealed.approvalId));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64url')), decipher.final()]).toString('utf8');
    const request = assertRequest(JSON.parse(plain));
    if (request.approvalId !== approvalId) return { ok: false, code: 'binding_mismatch' };
    return { ok: true, request };
  } catch {
    return { ok: false, code: 'unsealable' };
  }
}

module.exports = {
  SEALED_REQUEST_VERSION,
  generateSealKeyPair,
  sealDecisionRequest,
  openDecisionRequest,
};
