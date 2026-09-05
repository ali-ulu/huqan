'use strict';

const { recordLegacyAliasUse } = require('./legacy-alias-usage');

const ENVIRONMENT_SUFFIXES = Object.freeze([
  'A2A_AUTHORITY_FILE',
  'A2A_REPLAY_DIR',
  'AGENT_RUNTIME',
  'AGENT_VERSION',
  'API_KEY',
  'BACKUP_DIR',
  'CLI_READ_ROOTS',
  'COLLECTOR_SEAL_KEY',
  'COLLECTOR_SEAL_KEY_ID',
  'DB_PATH',
  'DEMO_MODE',
  'DISABLE_API_AUTH',
  'DISABLE_AUTO_LISTEN',
  'EXTERNAL_CLIENT_ENDPOINT_ENABLED',
  'EXTERNAL_CLIENT_REPLAY_DB_PATH',
  'EXTERNAL_CLIENT_TRUST_PROFILE_PATH',
  'RECEIPT_COLLECTOR_ROOT',
  'RECEIPT_REQUIRE_SIGNATURE',
  'RECEIPT_TRUSTED_KEYS',
  'REGISTRY_DIR',
  'GITHUB_APP_BETA_ENABLED',
  'GITHUB_APP_HOST',
  'GITHUB_APP_ID',
  'GITHUB_APP_PORT',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_STORE_PATH',
  'GITHUB_APP_STREAMING_TRUST_ENABLED',
  'GITHUB_APP_WEBHOOK_SECRET',
  'HOST',
  'HUMAN_APPROVAL_DISABLED',
  'HEADERS_TIMEOUT_MS',
  'INGEST_ALLOWED_ROOTS',
  'INGEST_APPROVAL_LEASE_MS',
  'KEEP_ALIVE_TIMEOUT_MS',
  'KERNEL_VERSION',
  'LANG',
  'MCP_CAPABILITY_NONCE_DIR',
  'MCP_LEGACY_VERIFY_STATUS',
  'MCP_OPERATOR_TOKEN',
  'MEMORY_PATH',
  'OBSERVABILITY_AUTHZ_POLICY',
  'PARANOID',
  'PLUGIN_PRODUCTION_ENFORCEMENT',
  'PLUGIN_SIGNING_KEY',
  'PLUGIN_STRICT',
  'REQUEST_TIMEOUT_MS',
  'SUPPLY_CHAIN_ACTIVATION_POLICY',
  'PORT',
  'RUST_BIN',
  'TRUST_POLICY_ROOTS',
  'TRUST_PROXY',
  'USE_SQLITE',
  'VIEWER_INSECURE_LOOPBACK',
]);

const ENVIRONMENT_SUFFIX_SET = new Set(ENVIRONMENT_SUFFIXES);

function hasOwn(environment, name) {
  return Object.prototype.hasOwnProperty.call(environment, name);
}

function assertEnvironment(environment) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    const error = new TypeError('environment must be an object');
    error.code = 'HUQAN_ENV_INVALID';
    throw error;
  }
}

function namesForSuffix(suffix) {
  if (!ENVIRONMENT_SUFFIX_SET.has(suffix)) {
    const error = new Error(`unknown HUQAN environment suffix: ${suffix}`);
    error.code = 'HUQAN_ENV_SUFFIX_UNKNOWN';
    throw error;
  }
  return {
    canonical: `HUQAN_${suffix}`,
    legacy: `AXIOM_${suffix}`,
  };
}

function readCompatibleEnvironmentVariable(suffix, environment = process.env) {
  assertEnvironment(environment);
  const { canonical, legacy } = namesForSuffix(suffix);
  const hasCanonical = hasOwn(environment, canonical);
  const hasLegacy = hasOwn(environment, legacy);

  if (hasCanonical && hasLegacy && environment[canonical] !== environment[legacy]) {
    const error = new Error(`conflicting environment variables: ${canonical} and ${legacy}`);
    error.code = 'HUQAN_ENV_CONFLICT';
    error.canonicalName = canonical;
    error.legacyName = legacy;
    throw error;
  }

  if (hasCanonical) return environment[canonical];
  if (hasLegacy) {
    // Only when the legacy name actually supplied the value. If both are set to
    // the same value the canonical one wins above and nothing is counted, which
    // is right: that deployment has already migrated and kept a spare.
    recordLegacyAliasUse('environment', legacy);
    return environment[legacy];
  }
  return undefined;
}

function validateEnvironmentCompatibility(environment = process.env) {
  assertEnvironment(environment);
  for (const suffix of ENVIRONMENT_SUFFIXES) {
    readCompatibleEnvironmentVariable(suffix, environment);
  }
  return true;
}

module.exports = {
  ENVIRONMENT_SUFFIXES,
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
};
