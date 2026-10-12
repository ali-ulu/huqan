'use strict';

// Signed proof that the approval authority recorded a decision as consumed
// (#3860, ADR-016).
//
// The decision guard accepts an approved decision only together with this
// envelope, so nothing can be carried out without an `approval.consumed`
// entry in the authority's ledger first -- the entry `huqan audit --authority`
// matches against local executions. Its own signing domain keeps it from ever
// passing as a decision or a response. It is deterministic for a ledger entry,
// so the service can hand it out again after a crash between consuming and
// executing.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const crypto = require('node:crypto');
const { stableStringify } = require('../hash-chain');
const { publicKeyOf, privateKeyOf } = require('./keys');
const { keyIdFor } = require('./decision-envelope');

const CONSUMPTION_VERSION = 'huqan.authority.consumed.v1';
const DOMAIN = `${CONSUMPTION_VERSION}\n`;
const FIELDS = Object.freeze(['v', 'approvalId', 'workspaceId', 'tool', 'actionHash', 'ledgerSeq', 'ledgerHash', 'consumedAt']);
const BINDING = Object.freeze(['approvalId', 'workspaceId', 'tool', 'actionHash']);
const HEX64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;

function wellFormed(payload) {
  return Boolean(payload) && typeof payload === 'object'
    && stableStringify(Object.keys(payload).sort()) === stableStringify([...FIELDS].sort())
    && payload.v === CONSUMPTION_VERSION
    && ['approvalId', 'workspaceId', 'tool', 'consumedAt'].every(f => typeof payload[f] === 'string' && payload[f].length > 0)
    && HEX64.test(payload.actionHash) && HEX64.test(payload.ledgerHash)
    && Number.isInteger(payload.ledgerSeq) && payload.ledgerSeq >= 0;
}

function signConsumption(fields, privateKey) {
  const payload = { v: CONSUMPTION_VERSION, ...fields };
  if (!wellFormed(payload)) throw new TypeError('malformed consumption');
  const key = privateKeyOf(privateKey, 'ed25519');
  const sig = crypto.sign(null, Buffer.from(DOMAIN + stableStringify(payload), 'utf8'), key).toString('base64url');
  return { alg: 'Ed25519', keyId: keyIdFor(key), sig, payload };
}

/** @returns {{ok: true, payload: object} | {ok: false, code: string}} */
function verifyConsumption(envelope, { publicKey, expected }) {
  const key = publicKeyOf(publicKey, 'ed25519');
  if (!envelope || envelope.alg !== 'Ed25519' || !wellFormed(envelope.payload) || typeof envelope.sig !== 'string'
    || !SIGNATURE.test(envelope.sig)) {
    return { ok: false, code: 'malformed' };
  }
  if (envelope.keyId !== keyIdFor(key)) return { ok: false, code: 'key_mismatch' };
  const signed = crypto.verify(null, Buffer.from(DOMAIN + stableStringify(envelope.payload), 'utf8'), key,
    Buffer.from(envelope.sig, 'base64url'));
  if (!signed) return { ok: false, code: 'signature_invalid' };
  if (BINDING.some(field => envelope.payload[field] !== expected?.[field])) return { ok: false, code: 'binding_mismatch' };
  return { ok: true, payload: envelope.payload };
}

module.exports = { CONSUMPTION_VERSION, signConsumption, verifyConsumption };
