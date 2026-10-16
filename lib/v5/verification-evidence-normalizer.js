'use strict';

const { isPlainObject } = require('../is-plain-object');

const CRYPTOGRAPHIC_EVIDENCE_REASONS = new Map([
  ['invalid', new Set(['signature_invalid'])],
  ['malformed', new Set([
    'input_malformed',
    'message_malformed',
    'public_key_malformed',
    'signature_malformed'
  ])],
  ['unsupported', new Set(['algorithm_unsupported'])]
]);

function hasOnlyOwnDataKeys(value, allowedKeys) {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.getOwnPropertyNames(value);
  if (!keys.every((key) => allowedKeys.has(key))) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor.enumerable && !descriptor.get && !descriptor.set;
  });
}

function malformedCryptographicEvidence() {
  return {
    cryptographicState: 'malformed',
    reasonCategory: 'input_malformed'
  };
}

function normalizeCryptographicVerificationEvidence(evidence) {
  try {
    if (!isPlainObject(evidence)) {
      return malformedCryptographicEvidence();
    }

    const stateDescriptor = Object.getOwnPropertyDescriptor(
      evidence,
      'cryptographicState'
    );
    if (!stateDescriptor || stateDescriptor.get || stateDescriptor.set) {
      return malformedCryptographicEvidence();
    }
    const state = stateDescriptor.value;
    if (state === 'valid') {
      if (!hasOnlyOwnDataKeys(evidence, new Set(['cryptographicState']))) {
        return malformedCryptographicEvidence();
      }
      return { cryptographicState: 'valid' };
    }

    const allowedReasons = CRYPTOGRAPHIC_EVIDENCE_REASONS.get(state);
    if (!allowedReasons || !hasOnlyOwnDataKeys(
      evidence,
      new Set(['cryptographicState', 'reasonCategory'])
    )) {
      return malformedCryptographicEvidence();
    }
    if (!allowedReasons.has(evidence.reasonCategory)) {
      return malformedCryptographicEvidence();
    }
    return {
      cryptographicState: state,
      reasonCategory: evidence.reasonCategory
    };
  } catch {
    return malformedCryptographicEvidence();
  }
}

module.exports = {
  CRYPTOGRAPHIC_EVIDENCE_REASONS,
  hasOnlyOwnDataKeys,
  malformedCryptographicEvidence,
  normalizeCryptographicVerificationEvidence
};
