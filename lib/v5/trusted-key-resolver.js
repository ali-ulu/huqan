'use strict';

const STATES = new Set([
  'active',
  'unknown',
  'revoked',
  'expired',
  'unavailable',
  'malformed'
]);

const REASONS = {
  unknown: 'unknown_key',
  revoked: 'revoked_key',
  expired: 'expired_key_metadata',
  unavailable: 'key_lookup_unavailable',
  malformed: 'malformed_trusted_key_record'
};

const ROOT_KEYS = new Set(['keyReference', 'records', 'evaluationTime']);
const RECORD_KEYS = new Set(['keyReference', 'status', 'expiresAt', 'publicKeySpkiDer']);
const FORBIDDEN_FIELDS = new Set([
  'privatekey', 'private_key', 'private-key', 'secret', 'token',
  'credential', 'password', 'keymaterial', 'key_material', 'pem',
  'certificate', 'jwk', 'provider', 'endpoint', 'networkendpoint',
  'network_endpoint', 'url', 'uri'
]);
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY_REFERENCE_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const KEY_REFERENCE_PATH_PATTERN = /[\\/?#@]/;
const KEY_REFERENCE_WHITESPACE_PATTERN = /\s/;
const KEY_REFERENCE_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_VALUE_PATTERN =
  /(?:-----BEGIN [^-]+ PRIVATE KEY-----|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|private[\s_-]*key\s*[:=]|key[\s_-]*material\s*[:=])/i;

const { isPlainObject } = require('../is-plain-object');

function isBoundedIdentifier(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    KEY_REFERENCE_WHITESPACE_PATTERN.test(value) ||
    KEY_REFERENCE_CONTROL_PATTERN.test(value) ||
    KEY_REFERENCE_PATH_PATTERN.test(value) ||
    FORBIDDEN_VALUE_PATTERN.test(value)
  ) {
    return false;
  }

  if (value.includes('://')) {
    return false;
  }

  const schemeMatch = value.match(KEY_REFERENCE_SCHEME_PATTERN);
  return !schemeMatch || schemeMatch[1].toLowerCase() === 'test-key';
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    return null;
  }

  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    return null;
  }

  return new Date(instant).toISOString() === value ? instant : null;
}

function isDenseArray(value) {
  if (!Array.isArray(value)) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return false;
    }
  }

  return true;
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasForbiddenContent(value, seen = new Set()) {
  try {
    if (value === null || typeof value !== 'object') {
      return typeof value === 'string' && FORBIDDEN_VALUE_PATTERN.test(value);
    }

    // Record metadata has no array-valued field. Reject arrays before any
    // element/property access so Proxy traps cannot escape this boundary.
    if (Array.isArray(value) || !isPlainObject(value) || seen.has(value)) {
      return true;
    }

    seen.add(value);
    const ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      if (typeof key !== 'string' || FORBIDDEN_FIELDS.has(key.toLowerCase())) {
        return true;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
        return true;
      }

      // The direct record field is validated separately as bounded public bytes.
      if (key === 'publicKeySpkiDer') {
        continue;
      }

      const child = descriptor.value;
      if (typeof child === 'string' && FORBIDDEN_VALUE_PATTERN.test(child)) {
        return true;
      }

      if (hasForbiddenContent(child, seen)) {
        return true;
      }
    }

    return false;
  } catch (error) {
    return true;
  }
}

function isValidPublicKey(value) {
  try {
    if (Buffer.isBuffer(value)) {
      return value.length === 44;
    }

    return value instanceof Uint8Array
      && value.constructor === Uint8Array
      && value.byteLength === 44;
  } catch (error) {
    return false;
  }
}

function copyPublicKey(value) {
  // Buffer.from(typedArray) copies only the visible bytes (honoring
  // byteOffset/byteLength) into a fresh buffer. The
  // (arrayBuffer, offset, length) overload is deliberately not used because it
  // can alias the backing store.
  try {
    const copy = Buffer.from(value);
    return copy.length === 44 ? copy : null;
  } catch (error) {
    return null;
  }
}

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

function validateRecord(record) {
  if (!isPlainObject(record) || !hasOnlyKeys(record, RECORD_KEYS)) {
    return false;
  }

  if (!isBoundedIdentifier(record.keyReference) || !STATES.has(record.status)) {
    return false;
  }

  if (record.expiresAt !== undefined && parseTimestamp(record.expiresAt) === null) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(record, 'publicKeySpkiDer')
    && !isValidPublicKey(record.publicKeySpkiDer)) {
    return false;
  }

  return true;
}

function resolveTrustedKeyState(input) {
  const root = snapshotRootInput(input);
  if (root === null) {
    return malformedResult();
  }

  if (!isBoundedIdentifier(root.keyReference)) {
    return malformedResult();
  }

  const evaluationInstant = parseTimestamp(root.evaluationTime);
  if (evaluationInstant === null) {
    return malformedResult();
  }

  // Capture each record's allowed fields and public key bytes exactly once
  // before any security decision. Accessor-backed, proxy-throwing, malformed,
  // or non-plain records snapshot to null and fail closed.
  const snapshots = root.records.map(snapshotRecord);
  if (snapshots.some((snapshot) => snapshot === null)) {
    return malformedResult();
  }

  if (snapshots.some((snapshot) => hasForbiddenContent(snapshot))) {
    return malformedResult();
  }

  if (!snapshots.every(validateRecord)) {
    return malformedResult();
  }

  const matches = snapshots.filter((snapshot) => (
    snapshot.keyReference === root.keyReference
  ));

  if (matches.length > 1) {
    return malformedResult();
  }

  if (matches.length === 0) {
    return stateResult('unknown');
  }

  const record = matches[0];

  if (record.status === 'unavailable') {
    return stateResult('unavailable');
  }

  if (record.status === 'revoked') {
    return stateResult('revoked');
  }

  if (record.status === 'unknown') {
    return stateResult('unknown');
  }

  if (record.status === 'malformed') {
    return malformedResult();
  }

  if (record.status === 'expired') {
    return stateResult('expired');
  }

  if (record.expiresAt !== undefined) {
    const expiryInstant = parseTimestamp(record.expiresAt);
    if (expiryInstant <= evaluationInstant) {
      return stateResult('expired');
    }
  }

  if (!Object.prototype.hasOwnProperty.call(record, 'publicKeySpkiDer')) {
    return malformedResult();
  }

  // `record` is the frozen snapshot; the key bytes were captured once and
  // already validated as a 44-byte Buffer/Uint8Array. Copy from that same
  // snapshot value and defensively re-check the resulting length so no path
  // can emit an active verdict carrying anything other than 44 bytes.
  const publicKeySpkiDer = copyPublicKey(record.publicKeySpkiDer);
  if (publicKeySpkiDer === null) {
    return malformedResult();
  }

  return {
    keyState: 'active',
    keyReference: root.keyReference,
    publicKeySpkiDer
  };
}

module.exports = {
  resolveTrustedKeyState
};
