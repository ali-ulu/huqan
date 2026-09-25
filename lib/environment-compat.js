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
  'EXPERIENCE_ENABLED',
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
  'ISSUER_SEAL_KEY',
  'KEEP_ALIVE_TIMEOUT_MS',
  'MAX_CONCURRENT_REQUESTS',
  'MAX_QUEUE_DEPTH',
  'KERNEL_VERSION',
  'LANG',
  'LLM_PROXY_API_KEY',
  'LLM_PROXY_TIMEOUT_MS',
  'LLM_PROXY_UPSTREAM',
  'MCP_CAPABILITY_NONCE_DIR',
  'MCP_LEGACY_VERIFY_STATUS',
  'MCP_OPERATOR_TOKEN',
  'MEMORY_PATH',
  'NOTIFY_WEBHOOK_SECRET',
  'NOTIFY_WEBHOOK_URL',
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

// Boot seam for the local-first runtimes (Gate A item 6, #2366). CLI and MCP
// need no API key; what stops them is contradictory configuration — the same
// HUQAN_ENV_CONFLICT the server refuses — reported with an operator-readable
// line instead of a raw require-time stack. Values never enter the message:
// the errors above name variables, not secrets.
function assertBootEnvironment(environment = process.env) {
  validateEnvironmentCompatibility(environment);
}

function formatBootError(runtime, error) {
  const code = error && error.code ? error.code : 'STARTUP_VALIDATION_FAILED';
  const message = error && error.message ? error.message : String(error);
  return `HUQAN ${runtime} cannot start: ${message} (code=${code})`;
}

function reportBootError(runtime, error) {
  console.error(formatBootError(runtime, error));
}

// True when the error was a boot conflict and has been reported: entries keep
// a single glue line and stay out of the file-size ledger.
function reportBootConflict(runtime, error) {
  if (error && error.code === 'HUQAN_ENV_CONFLICT') {
    reportBootError(runtime, error);
    return true;
  }
  return false;
}

module.exports = {
  ENVIRONMENT_SUFFIXES,
  assertBootEnvironment,
  formatBootError,
  readCompatibleEnvironmentVariable,
  reportBootConflict,
  reportBootError,
  validateEnvironmentCompatibility,
};
