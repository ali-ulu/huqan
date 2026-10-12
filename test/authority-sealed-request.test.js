'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateSealKeyPair, sealDecisionRequest, openDecisionRequest, SEALED_REQUEST_VERSION,
} = require('../lib/authority/sealed-request');

const REQUEST = Object.freeze({
  approvalId: 'apr_1', actionHash: 'a'.repeat(64), decision: 'approved', reason: 'checked', totp: '287082',
});

test('the authority opens what the operator client sealed to it', () => {
  const { publicKey, privateKey } = generateSealKeyPair();
  const sealed = sealDecisionRequest(REQUEST, publicKey);
  assert.equal(sealed.v, SEALED_REQUEST_VERSION);
  assert.equal(sealed.approvalId, 'apr_1');
  assert.equal(JSON.stringify(sealed).includes('287082'), false, 'the code never travels in clear');
  assert.deepEqual(openDecisionRequest(sealed, privateKey, { approvalId: 'apr_1' }), { ok: true, request: REQUEST });
});

// The relay attack: an impostor on the authority's port receives the sealed
// request for approval A and tries to spend the operator's code on B.
test('a sealed request cannot be re-pointed at another approval', () => {
  const { publicKey, privateKey } = generateSealKeyPair();
  const sealed = sealDecisionRequest(REQUEST, publicKey);
  assert.deepEqual(openDecisionRequest(sealed, privateKey, { approvalId: 'apr_2' }), { ok: false, code: 'binding_mismatch' });
  const relabelled = { ...sealed, approvalId: 'apr_2' };
  assert.deepEqual(openDecisionRequest(relabelled, privateKey, { approvalId: 'apr_2' }), { ok: false, code: 'unsealable' });
});

test('any change to the ciphertext, nonce or ephemeral key is refused', () => {
  const { publicKey, privateKey } = generateSealKeyPair();
  const sealed = sealDecisionRequest(REQUEST, publicKey);
  const flip = text => {
    const bytes = Buffer.from(text, 'base64url');
    bytes[0] ^= 1;
    return bytes.toString('base64url');
  };
  for (const field of ['ct', 'tag', 'nonce', 'epk']) {
    assert.deepEqual(openDecisionRequest({ ...sealed, [field]: flip(sealed[field]) }, privateKey, { approvalId: 'apr_1' }),
      { ok: false, code: 'unsealable' }, field);
  }
});

test('only the holder of the authority sealing key can open it', () => {
  const authority = generateSealKeyPair();
  const impostor = generateSealKeyPair();
  const sealed = sealDecisionRequest(REQUEST, authority.publicKey);
  assert.deepEqual(openDecisionRequest(sealed, impostor.privateKey, { approvalId: 'apr_1' }), { ok: false, code: 'unsealable' });
});

test('sealing refuses a malformed request, and opening refuses a malformed envelope', () => {
  const { publicKey, privateKey } = generateSealKeyPair();
  for (const [field, value] of [['decision', 'maybe'], ['totp', '12345'], ['actionHash', 'x'], ['approvalId', '']]) {
    assert.throws(() => sealDecisionRequest({ ...REQUEST, [field]: value }, publicKey), TypeError, field);
  }
  for (const sealed of [null, {}, { v: 'other' }, { ...sealDecisionRequest(REQUEST, publicKey), epk: 'short' }]) {
    assert.deepEqual(openDecisionRequest(sealed, privateKey, { approvalId: 'apr_1' }), { ok: false, code: 'malformed' });
  }
});
