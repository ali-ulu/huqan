'use strict';

// #2204: the key states and reasons, input shape limits and the value checks
// (identifiers, timestamps, forbidden key material, public key bytes) the
// trusted key resolver applies.

const { isPlainObject } = require('../is-plain-object');

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
const KEY_REFERENCE_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/; // oxlint-disable-line no-control-regex -- deliberate: the control-character class a key reference may not contain
const FORBIDDEN_VALUE_PATTERN =
  /(?:-----BEGIN [^-]+ PRIVATE KEY-----|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|private[\s_-]*key\s*[:=]|key[\s_-]*material\s*[:=])/i;


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

module.exports = {
  REASONS,
  RECORD_KEYS,
  ROOT_KEYS,
  STATES,
  copyPublicKey,
  hasForbiddenContent,
  hasOnlyKeys,
  isBoundedIdentifier,
  isValidPublicKey,
  parseTimestamp,
};
