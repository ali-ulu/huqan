'use strict';

const SUPPORTED_SCHEMA_VERSION = 'v5.shared_trust_package.writer_input.v1';

const ALLOWED_INPUT_KEYS = new Set([
  'schemaVersion',
  'algorithm',
  'payload',
  'signature',
  'keyReference',
  'trustedKeyMetadata',
  'claims',
  'evaluationTime'
]);
const ALLOWED_PAYLOAD_KEYS = new Set([
  'canonicalization',
  'payloadId',
  'signedPayloadId',
  'contentRef',
  'payloadDigest',
  'expectedPayloadDigest'
]);
const ALLOWED_TRUSTED_KEY_METADATA_KEYS = new Set([
  'status',
  'keyReference',
  'expiresAt'
]);
const FORBIDDEN_KEY_MATERIAL_KEYS = new Set([
  'privatekey',
  'private_key',
  'secret',
  'credential',
  'token',
  'password',
  'networkendpoint',
  'network_endpoint',
  'url',
  'uri',
  'endpoint',
  'certificate',
  'pem',
  'jwk',
  'keymaterial',
  'key_material'
]);

const { isPlainObject } = require('../is-plain-object');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function containsForbiddenKeyMaterial(value) {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenKeyMaterial);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(([key, nestedValue]) => (
    FORBIDDEN_KEY_MATERIAL_KEYS.has(key.toLowerCase()) ||
    containsForbiddenKeyMaterial(nestedValue)
  ));
}

function malformedInput(input) {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ALLOWED_INPUT_KEYS)) {
    return true;
  }
  if (input.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return true;
  }
  if (!isPlainObject(input.payload) || !hasOnlyKeys(input.payload, ALLOWED_PAYLOAD_KEYS)) {
    return true;
  }
  if (
    input.payload.canonicalization !== 'json-stable-v1' ||
    !isNonEmptyString(input.payload.payloadId) ||
    !isNonEmptyString(input.payload.contentRef) ||
    !isNonEmptyString(input.payload.payloadDigest)
  ) {
    return true;
  }
  if (!isNonEmptyString(input.keyReference)) {
    return true;
  }
  if (!isPlainObject(input.trustedKeyMetadata)) {
    return true;
  }
  if (!isNonEmptyString(input.evaluationTime) || Number.isNaN(Date.parse(input.evaluationTime))) {
    return true;
  }
  return false;
}

module.exports = {
  ALLOWED_TRUSTED_KEY_METADATA_KEYS,
  FORBIDDEN_KEY_MATERIAL_KEYS,
  SUPPORTED_SCHEMA_VERSION,
  containsForbiddenKeyMaterial,
  hasOnlyKeys,
  isNonEmptyString,
  malformedInput
};
