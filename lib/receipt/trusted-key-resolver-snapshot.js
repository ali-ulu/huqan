'use strict';

// #2204: own-data snapshots of the resolver input and its records, taken
// before any validation so caller getters and proxies run at most once, and
// the result records the resolver returns.

const { isPlainObject } = require('../is-plain-object');
const { REASONS, RECORD_KEYS, ROOT_KEYS, copyPublicKey, isValidPublicKey } = require('./trusted-key-resolver-guards');

function snapshotOwnDataObject(value, allowedKeys) {
  if (!isPlainObject(value)) {
    return null;
  }

  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (error) {
    return null;
  }

  const snapshot = Object.create(null);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      return null;
    }

    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (error) {
      return null;
    }

    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
      return null;
    }

    snapshot[key] = descriptor.value;
  }

  return snapshot;
}

function snapshotDenseArray(value) {
  let isArray;
  try {
    isArray = Array.isArray(value);
  } catch (error) {
    return null;
  }

  if (!isArray) {
    return null;
  }

  let lengthDescriptor;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch (error) {
    return null;
  }

  if (
    !lengthDescriptor
    || !('value' in lengthDescriptor)
    || lengthDescriptor.get
    || lengthDescriptor.set
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    return null;
  }

  const snapshot = new Array(lengthDescriptor.value);
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch (error) {
      return null;
    }

    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
      return null;
    }

    snapshot[index] = descriptor.value;
  }

  return Object.freeze(snapshot);
}

function snapshotRootInput(input) {
  const snapshot = snapshotOwnDataObject(input, ROOT_KEYS);
  if (snapshot === null) {
    return null;
  }

  const records = snapshotDenseArray(snapshot.records);
  if (records === null) {
    return null;
  }

  snapshot.records = records;
  return Object.freeze(snapshot);
}

// Snapshot the allowed record fields exactly once, reading each only through an
// own DATA property descriptor. Accessor (get/set) descriptors are rejected
// fail-closed. Public key bytes are copied at snapshot time so later proxy side
// effects or caller mutation cannot change the key that was captured for this
// resolution.
function snapshotRecord(record) {
  const snapshot = snapshotOwnDataObject(record, RECORD_KEYS);
  if (snapshot === null) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, 'publicKeySpkiDer')) {
    if (!isValidPublicKey(snapshot.publicKeySpkiDer)) {
      return null;
    }

    const publicKeySpkiDer = copyPublicKey(snapshot.publicKeySpkiDer);
    if (publicKeySpkiDer === null) {
      return null;
    }
    snapshot.publicKeySpkiDer = publicKeySpkiDer;
  }

  return Object.freeze(snapshot);
}

function malformedResult() {
  return {
    keyState: 'malformed',
    reasonCategory: REASONS.malformed
  };
}

function stateResult(keyState) {
  if (keyState === 'active') {
    return { keyState };
  }

  return {
    keyState,
    reasonCategory: REASONS[keyState]
  };
}

module.exports = {
  malformedResult,
  snapshotRecord,
  snapshotRootInput,
  stateResult,
};
