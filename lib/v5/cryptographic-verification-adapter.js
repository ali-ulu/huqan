'use strict';

const crypto = require('node:crypto');

const SUPPORTED_ALGORITHM = 'ed25519-v1';
const MAX_MESSAGE_BYTES = 1048576;
const REQUIRED_KEYS = new Set([
  'algorithm',
  'messageBytes',
  'publicKeySpkiDer',
  'signatureBytes'
]);

function malformed(reasonCategory) {
  return { cryptographicState: 'malformed', reasonCategory };
}

function unsupportedAlgorithm() {
  return {
    cryptographicState: 'unsupported',
    reasonCategory: 'algorithm_unsupported'
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasInheritedEnumerableState(value) {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      return true;
    }
  }
  return false;
}

function readRootValues(input) {
  if (!isPlainObject(input) || hasInheritedEnumerableState(input)) {
    return null;
  }

  if (Object.getOwnPropertySymbols(input).length > 0) {
    return null;
  }

  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.getOwnPropertyNames(input);
  if (keys.length !== REQUIRED_KEYS.size) {
    return null;
  }

  for (const key of keys) {
    if (!REQUIRED_KEYS.has(key)) {
      return null;
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      return null;
    }
  }

  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(input, key)) {
      return null;
    }
  }

  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function copyBytes(value) {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return null;
}

function verifyCryptographicEvidence(input) {
  let values;
  try {
    values = readRootValues(input);
  } catch {
    return malformed('input_malformed');
  }

  if (!values) {
    return malformed('input_malformed');
  }

  if (typeof values.algorithm !== 'string') {
    return malformed('input_malformed');
  }
  if (values.algorithm !== SUPPORTED_ALGORITHM) {
    return unsupportedAlgorithm();
  }

  const messageBytes = copyBytes(values.messageBytes);
  if (!messageBytes || messageBytes.length < 1 || messageBytes.length > MAX_MESSAGE_BYTES) {
    return malformed('message_malformed');
  }

  const publicKeyBytes = copyBytes(values.publicKeySpkiDer);
  if (!publicKeyBytes || publicKeyBytes.length !== 44) {
    return malformed('public_key_malformed');
  }

  const signatureBytes = copyBytes(values.signatureBytes);
  if (!signatureBytes || signatureBytes.length !== 64) {
    return malformed('signature_malformed');
  }

  let keyObject;
  try {
    keyObject = crypto.createPublicKey({
      key: publicKeyBytes,
      format: 'der',
      type: 'spki'
    });
  } catch {
    return malformed('public_key_malformed');
  }

  if (keyObject.asymmetricKeyType !== 'ed25519') {
    return malformed('public_key_malformed');
  }

  try {
    const verified = crypto.verify(
      null,
      messageBytes,
      keyObject,
      signatureBytes
    );
    return verified
      ? { cryptographicState: 'valid' }
      : { cryptographicState: 'invalid', reasonCategory: 'signature_invalid' };
  } catch {
    return malformed('input_malformed');
  }
}

module.exports = {
  verifyCryptographicEvidence
};
