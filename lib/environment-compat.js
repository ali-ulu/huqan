'use strict';

const ENVIRONMENT_SUFFIXES = Object.freeze([
  'A2A_AUTHORITY_FILE',
  'A2A_REPLAY_DIR',
  'AGENT_GATE_ALLOWLIST',
  'AGENT_GATE_LOG',
  'AGENT_RUNTIME',
  'AGENT_VERSION',
  'API_KEY',
  'BACKUP_DIR',
  'CLI_READ_ROOTS',
  'DB_PATH',
  'DEMO_MODE',
  'DISABLE_AUTO_LISTEN',
  'EXTERNAL_CLIENT_ENDPOINT_ENABLED',
  'EXTERNAL_CLIENT_REPLAY_DB_PATH',
  'EXTERNAL_CLIENT_TRUST_PROFILE_PATH',
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
  'INGEST_APPROVAL_LEASE_MS',
  'KERNEL_VERSION',
  'LANG',
  'MEMORY_PATH',
  'PARANOID',
  'PLUGIN_PRODUCTION_ENFORCEMENT',
  'PLUGIN_SIGNING_KEY',
  'PLUGIN_STRICT',
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
  if (hasLegacy) return environment[legacy];
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
