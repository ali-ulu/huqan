'use strict';

// #2231: startup configuration extracted from github-app-beta-http-boundary.
// One job: read and validate beta + Streaming Trust env config, fail closed
// with a cause-attached (never secret-printing) error. No request handling.

const fs = require('node:fs');

const {
  readCompatibleEnvironmentVariable,
} = require('./environment-compat');
const {
  createGitHubAppJwt,
  isValidWebhookSecret,
} = require('./github-app-beta-auth');
const {
  createGitHubAppStreamingTrustStore,
} = require('./github-app-streaming-trust-store');

const GITHUB_APP_BETA_ENABLE_ENV = 'GITHUB_APP_BETA_ENABLED';
const GITHUB_APP_WEBHOOK_SECRET_ENV = 'GITHUB_APP_WEBHOOK_SECRET';
const GITHUB_APP_STORE_PATH_ENV = 'GITHUB_APP_STORE_PATH';

// Streaming Trust is opted into separately, and deliberately so. The beta flag
// starts a server that only observes: it verifies a signature, records a
// receipt, and answers. Streaming Trust writes check runs back to the pull
// request. Hanging an outbound mutation off a flag someone already set for an
// observer would mean a variable changed its meaning underneath whoever set it.
const GITHUB_APP_STREAMING_TRUST_ENABLE_ENV = 'GITHUB_APP_STREAMING_TRUST_ENABLED';
const GITHUB_APP_ID_ENV = 'GITHUB_APP_ID';
const GITHUB_APP_PRIVATE_KEY_PATH_ENV = 'GITHUB_APP_PRIVATE_KEY_PATH';

function failConfig(cause) {
  const error = new Error('GitHub App beta production configuration is invalid');
  error.code = 'GITHUB_APP_BETA_CONFIG_INVALID';
  // The message stays deliberately incurious -- it is a startup error that must
  // not print a key path or a secret. But swallowing the cause entirely means a
  // misconfiguration and a genuine bug in this file look identical from the
  // outside, which cost real debugging time while wiring #694. The cause is
  // attached, not formatted into the message.
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function readStreamingTrustConfig(environment, storePath) {
  const enabled = readCompatibleEnvironmentVariable(GITHUB_APP_STREAMING_TRUST_ENABLE_ENV, environment);
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') failConfig();

  const appId = readCompatibleEnvironmentVariable(GITHUB_APP_ID_ENV, environment);
  const privateKeyPath = readCompatibleEnvironmentVariable(GITHUB_APP_PRIVATE_KEY_PATH_ENV, environment);
  if (typeof appId !== 'string' || !/^[0-9]{1,20}$/.test(appId)
      || typeof privateKeyPath !== 'string' || privateKeyPath.length === 0) failConfig();

  let privateKey;
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch (error) {
    failConfig(error);
  }
  // Validated with the auth layer's own predicate rather than a rule restated
  // here, for the reason #646 records: a key the JWT path would refuse must
  // fail at startup, not on the first genuine delivery.
  try {
    createGitHubAppJwt({ appId, privateKey, nowMs: Date.now() });
  } catch (error) {
    failConfig(error);
  }

  return Object.freeze({
    appId,
    privateKey,
    // Same root as the observation store: the C8 store namespaces its own
    // records underneath it, and one configured path is one thing to get right.
    store: createGitHubAppStreamingTrustStore({ rootPath: storePath }),
  });
}

function readBetaConfig(environment) {
  const enabled = readCompatibleEnvironmentVariable(GITHUB_APP_BETA_ENABLE_ENV, environment);
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') failConfig();

  const webhookSecret = readCompatibleEnvironmentVariable(GITHUB_APP_WEBHOOK_SECRET_ENV, environment);
  const storePath = readCompatibleEnvironmentVariable(GITHUB_APP_STORE_PATH_ENV, environment);
  // #646: the secret is validated with the auth layer's own predicate rather
  // than a restated rule here. A secret the HMAC path would refuse must fail
  // at startup, not on the first genuine delivery -- restating the rule is how
  // '   ' and 'secret\n' came to start a server that 401'd every webhook.
  if (!isValidWebhookSecret(webhookSecret)
      || typeof storePath !== 'string' || storePath.length === 0) failConfig();

  return { webhookSecret, storePath };
}

module.exports = Object.freeze({
  GITHUB_APP_BETA_ENABLE_ENV,
  GITHUB_APP_WEBHOOK_SECRET_ENV,
  GITHUB_APP_STORE_PATH_ENV,
  GITHUB_APP_STREAMING_TRUST_ENABLE_ENV,
  GITHUB_APP_ID_ENV,
  GITHUB_APP_PRIVATE_KEY_PATH_ENV,
  failConfig,
  readStreamingTrustConfig,
  readBetaConfig,
});
