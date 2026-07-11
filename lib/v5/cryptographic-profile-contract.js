'use strict';

const MAX_MESSAGE_BYTES = 1048576;
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

const CRYPTOGRAPHIC_PROFILE_V1 = deepFreeze({
  profileId: 'ed25519-v1',
  signedContentMode: 'canonical-message-bytes',
  canonicalization: 'json-stable-v1',
  textEncoding: 'utf-8',
  messageBytes: {
    minimum: 1,
    maximum: MAX_MESSAGE_BYTES
  },
  publicKey: {
    representation: 'ed25519-spki-der',
    exactLength: 44
  },
  signature: {
    representation: 'ed25519-raw',
    exactLength: 64
  },
  adapterInputKeys: [
    'algorithm',
    'messageBytes',
    'publicKeySpkiDer',
    'signatureBytes'
  ],
  adapterStates: [
    'valid',
    'invalid',
    'malformed',
    'unsupported'
  ],
  adapterReasons: [
    'signature_invalid',
    'input_malformed',
    'message_malformed',
    'public_key_malformed',
    'signature_malformed',
    'algorithm_unsupported'
  ],
  futureRuntimePrimitive: 'node:crypto'
});

function reject(reason) {
  throw new TypeError('Unsupported json-stable-v1 value: ' + reason);
}

function hasInheritedEnumerableState(value) {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      return true;
    }
  }
  return false;
}

function isPlainJsonObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeArray(value, active) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    reject('symbol property');
  }

  const ownNames = Object.getOwnPropertyNames(value);
  for (const name of ownNames) {
    if (name === 'length') {
      continue;
    }
    if (!ARRAY_INDEX_PATTERN.test(name) || Number(name) >= value.length) {
      reject('array property');
    }
  }

  active.add(value);
  try {
    const parts = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        reject('sparse array');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
        reject('array accessor');
      }
      parts.push(serializeValue(descriptor.value, active));
    }
    return '[' + parts.join(',') + ']';
  } finally {
    active.delete(value);
  }
}

function serializeObject(value, active) {
  if (!isPlainJsonObject(value)) {
    reject('non-plain object');
  }
  if (hasInheritedEnumerableState(value)) {
    reject('inherited enumerable state');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    reject('symbol property');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownNames = Object.getOwnPropertyNames(value);
  for (const name of ownNames) {
    const descriptor = descriptors[name];
    if (!descriptor.enumerable) {
      reject('non-enumerable property');
    }
    if (descriptor.get || descriptor.set) {
      reject('accessor property');
    }
    if (name === 'toJSON' && typeof descriptor.value === 'function') {
      reject('custom toJSON');
    }
  }

  active.add(value);
  try {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => (
      JSON.stringify(key) + ':' + serializeValue(descriptors[key].value, active)
    )).join(',') + '}';
  } finally {
    active.delete(value);
  }
}

function serializeValue(value, active) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      reject('non-finite number');
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    reject('unsupported primitive');
  }
  if (active.has(value)) {
    reject('cyclic graph');
  }
  if (Array.isArray(value)) {
    return serializeArray(value, active);
  }
  return serializeObject(value, active);
}

function encodeJsonStableV1(value) {
  const serialized = serializeValue(value, new WeakSet());
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new RangeError('json-stable-v1 message exceeds maximum bytes');
  }
  return bytes;
}

module.exports = {
  CRYPTOGRAPHIC_PROFILE_V1,
  encodeJsonStableV1
};
