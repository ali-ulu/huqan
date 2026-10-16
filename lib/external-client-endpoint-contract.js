'use strict';

const EXTERNAL_CLIENT_ENDPOINT_CONTRACT_VERSION = 'external-client-endpoint-0-v1';
const EXTERNAL_CLIENT_ENDPOINT_PATH = '/api/external-client/packages/admit';
const EXTERNAL_CLIENT_ENDPOINT_METHOD = 'POST';
const EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV = 'HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED';
const EXTERNAL_CLIENT_ENDPOINT_LEGACY_ENABLE_ENV = 'AXIOM_EXTERNAL_CLIENT_ENDPOINT_ENABLED';
const EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID = 'EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID';

const CONTRACT_KEYS = Object.freeze([
  'contractVersion',
  'path',
  'method',
  'configKey',
  'configurationState',
  'routeReachable',
  'identityAuthorityReady',
  'workspaceAuthorityReady',
  'freshnessReady',
  'replayProtectionReady',
  'mutationAllowed',
  'receiptWriterReady',
]);

function failInvalidConfiguration(value) {
  const error = new Error('external client endpoint configuration is invalid');
  error.code = EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID;
  error.details = Object.freeze({
    configKey: EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV,
    valueType: value === null ? 'null' : typeof value,
  });
  throw error;
}

function readOwnConfigurationValue(environment) {
  if (environment === undefined) return undefined;
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    failInvalidConfiguration(environment);
  }

  const prototype = Object.getPrototypeOf(environment);
  if (prototype !== Object.prototype && prototype !== null) {
    failInvalidConfiguration(environment);
  }

  const descriptors = new Map();
  for (const name of [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV, EXTERNAL_CLIENT_ENDPOINT_LEGACY_ENABLE_ENV]) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      failInvalidConfiguration(undefined);
    }
    if (descriptor) descriptors.set(name, descriptor);
  }
  const canonical = descriptors.get(EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV);
  const legacy = descriptors.get(EXTERNAL_CLIENT_ENDPOINT_LEGACY_ENABLE_ENV);
  if (canonical && legacy && canonical.value !== legacy.value) {
    const error = new Error(`conflicting environment variables: ${EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV} and ${EXTERNAL_CLIENT_ENDPOINT_LEGACY_ENABLE_ENV}`);
    error.code = 'HUQAN_ENV_CONFLICT';
    error.canonicalName = EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV;
    error.legacyName = EXTERNAL_CLIENT_ENDPOINT_LEGACY_ENABLE_ENV;
    throw error;
  }
  if (canonical) return canonical.value;
  if (legacy) return legacy.value;
  return undefined;
}

function normalizeConfigurationState(value) {
  if (value === undefined || value === false || value === 0) return 'disabled';
  if (value === true || value === 1) return 'requested';

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '' || normalized === '0' || normalized === 'false') {
      return 'disabled';
    }
    if (normalized === '1' || normalized === 'true') {
      return 'requested';
    }
  }

  failInvalidConfiguration(value);
}

function buildExternalClientEndpointContract(environment) {
  const configurationState = normalizeConfigurationState(
    readOwnConfigurationValue(environment),
  );
  const contract = Object.assign(Object.create(null), {
    contractVersion: EXTERNAL_CLIENT_ENDPOINT_CONTRACT_VERSION,
    path: EXTERNAL_CLIENT_ENDPOINT_PATH,
    method: EXTERNAL_CLIENT_ENDPOINT_METHOD,
    configKey: EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV,
    configurationState,
    routeReachable: false,
    identityAuthorityReady: false,
    workspaceAuthorityReady: false,
    freshnessReady: false,
    replayProtectionReady: false,
    mutationAllowed: false,
    receiptWriterReady: false,
  });

  if (
    Object.keys(contract).length !== CONTRACT_KEYS.length
    || !CONTRACT_KEYS.every((key, index) => Object.keys(contract)[index] === key)
  ) {
    throw new Error('external client endpoint contract shape invariant failed');
  }

  return Object.freeze(contract);
}

module.exports = {
  EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID,
  EXTERNAL_CLIENT_ENDPOINT_CONTRACT_VERSION,
  EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV,
  EXTERNAL_CLIENT_ENDPOINT_METHOD,
  EXTERNAL_CLIENT_ENDPOINT_PATH,
  buildExternalClientEndpointContract,
};
