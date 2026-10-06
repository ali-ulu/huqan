'use strict';

// #3474 I6: the model-agnostic cognitive model port. It is a pure contract, so
// these are its positive and negative characterizations.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COGNITIVE_MODEL_SCHEMA_VERSION,
  MODEL_AUTHORITY,
  PORT_STATUS,
  PORT_ERROR_CODES,
  validateProposal,
  buildProposal,
} = require('../lib/cognitive-model-port');

function proposal(overrides = {}) {
  return {
    schemaVersion: COGNITIVE_MODEL_SCHEMA_VERSION,
    modelId: 'local-ssm-1-8',
    kind: 'SSM',
    locality: 'LOCAL',
    modelDigest: 'a'.repeat(64),
    answer: { label: 'positive', score: 0.5 },
    confidence: 0.5,
    budget: { modelCalls: 0, tokens: 0, operations: 64 },
    ...overrides,
  };
}

function codes(result) {
  return result.errors.map((item) => item.code);
}

test('a well-formed local proposal is VALID and carries no authority', () => {
  const result = validateProposal(proposal());
  assert.equal(result.status, PORT_STATUS.VALID);
  assert.equal(result.proposal.authority, MODEL_AUTHORITY);
  assert.equal(result.proposal.canonical, false);
  assert.ok(Object.isFrozen(result.proposal));
  // A built proposal re-validates, so a model can hand its own output back.
  assert.equal(validateProposal(result.proposal).status, PORT_STATUS.VALID);
});

test('a missing or unknown field is rejected rather than ignored', () => {
  const missing = validateProposal(proposal({ confidence: undefined }));
  assert.equal(missing.status, PORT_STATUS.REJECT);
  assert.ok(codes(missing).includes(PORT_ERROR_CODES.MISSING_FIELD));

  const unknown = validateProposal({ ...proposal(), smuggled: 1 });
  assert.equal(unknown.status, PORT_STATUS.REJECT);
  assert.ok(codes(unknown).includes(PORT_ERROR_CODES.UNKNOWN_FIELD));

  // The two output fields are validated too: a caller cannot claim authority.
  const forged = validateProposal(proposal({ authority: true }));
  assert.equal(forged.status, PORT_STATUS.REJECT);
  assert.ok(codes(forged).includes(PORT_ERROR_CODES.INVALID_FIELD));
});

test('a non-finite number is rejected, never scored', () => {
  const nan = validateProposal(proposal({ answer: { label: 'positive', score: NaN } }));
  assert.equal(nan.status, PORT_STATUS.REJECT);
  assert.ok(codes(nan).includes(PORT_ERROR_CODES.NON_FINITE_NUMBER));

  const infinite = validateProposal(proposal({ confidence: Infinity }));
  assert.equal(infinite.status, PORT_STATUS.REJECT);
  assert.ok(codes(infinite).includes(PORT_ERROR_CODES.NON_FINITE_NUMBER));

  const outOfRange = validateProposal(proposal({ confidence: 2 }));
  assert.ok(codes(outOfRange).includes(PORT_ERROR_CODES.INVALID_FIELD));
});

test('an external locality is refused even when every other field is well-formed', () => {
  const result = validateProposal(proposal({ locality: 'EXTERNAL' }));
  assert.equal(result.status, PORT_STATUS.REJECT);
  assert.ok(codes(result).includes(PORT_ERROR_CODES.EXTERNAL_CALL));
});

test('buildProposal throws a typed error and otherwise freezes the proposal', () => {
  assert.throws(() => buildProposal(proposal({ locality: 'EXTERNAL' })), (error) => {
    assert.equal(error.code, PORT_ERROR_CODES.EXTERNAL_CALL);
    assert.equal(error.path, 'locality');
    return true;
  });
  const built = buildProposal(proposal());
  assert.equal(built.answer.label, 'positive');
  assert.equal(built.authority, MODEL_AUTHORITY);
});
