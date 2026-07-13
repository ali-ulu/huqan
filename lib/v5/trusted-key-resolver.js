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

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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

function hasForbiddenContent(value) {
  if (Array.isArray(value)) {
    return value.some(hasForbiddenContent);
  }

  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && FORBIDDEN_VALUE_PATTERN.test(value);
  }

  if (!isPlainObject(value)) {
    return true;
  }

  return Object.entries(value).some(([key, child]) => {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      return true;
    }

    // The direct record field is validated separately as bounded public bytes.
    if (key === 'publicKeySpkiDer') {
      return false;
    }

    if (typeof child === 'string' && FORBIDDEN_VALUE_PATTERN.test(child)) {
      return true;
    }

    return hasForbiddenContent(child);
  });
}

function isValidPublicKey(value) {
  if (Buffer.isBuffer(value)) {
    return value.length === 44;
  }

  return value instanceof Uint8Array
    && value.constructor === Uint8Array
    && value.byteLength === 44;
}

function copyPublicKey(value) {
  return Buffer.from(value);
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
  if (!isPlainObject(input)) {
    return malformedResult();
  }

  if (!hasOnlyKeys(input, ROOT_KEYS)) {
    return malformedResult();
  }

  if (!isBoundedIdentifier(input.keyReference)) {
    return malformedResult();
  }

  const evaluationInstant = parseTimestamp(input.evaluationTime);
  if (evaluationInstant === null) {
    return malformedResult();
  }

  if (!isDenseArray(input.records)) {
    return malformedResult();
  }

  if (input.records.some((record) => hasForbiddenContent(record))) {
    return malformedResult();
  }

  if (!input.records.every(validateRecord)) {
    return malformedResult();
  }

  const matches = input.records.filter((record) => (
    record.keyReference === input.keyReference
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

  return {
    keyState: 'active',
    keyReference: input.keyReference,
    publicKeySpkiDer: copyPublicKey(record.publicKeySpkiDer)
  };
}

module.exports = {
  resolveTrustedKeyState
};
