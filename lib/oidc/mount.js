// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

// The OIDC mount (#4267; contract in docs/sso.md).
//
// The composition root calls createOidcMount() once and gets back either a
// live mount or a disabled one. It never throws: a deployment that configured
// no OIDC, or configured it wrongly, keeps the API-key behaviour it had, and
// the reason is recorded so the health surface can say so. Refusing to boot
// over a half-configured SSO would take a working deployment down, which is a
// worse failure than an unavailable feature.
//
// The mount owns the pieces the route and the auth seam share: one session
// store (so a session the route creates is the one the seam validates) and one
// auth seam. `enabled` is the single answer to "is SSO advertised?" -- the
// contract requires it to be false until a provider smoke test passes.

const { loadOidcConfig } = require('./config');
const { createOidcClient } = require('./client');
const { createOidcSessionStore } = require('./session-store');
const { createOidcRoute, isOidcPath } = require('./route');
const { createOidcAuthSeam } = require('./auth-seam');
const { loadApprovalRbacPolicy } = require('../approval-rbac');

/**
 * @param {object} [opts]
 * @param {object} [opts.configResult] - a pre-loaded loadOidcConfig() result
 *   (test seam); when absent the environment is read.
 * @param {object} [opts.client] - the openid-client module (test seam)
 * @param {function} [opts.createSessionStore] - store factory (test seam)
 * @param {function} [opts.auditSink] - receives auth audit events
 * @param {boolean} [opts.enabled] - whether the deployment advertises SSO;
 *   defaults to false and is only set true after a provider smoke test.
 * @param {boolean} [opts.secureCookie] - use the __Host- cookie name
 */
function createOidcMount(opts = {}) {
  const configResult = opts.configResult || loadOidcConfig();
  // An unusable mount claims none of its paths: with no OIDC (or a broken
  // configuration) an OIDC-shaped request must behave exactly as it did before
  // this slice -- an unknown route -- instead of being captured by a router
  // that cannot answer it. lib/saml/sp-route.js returns the same no-op router.
  const unconfigured = { isOidcPath: () => false };
  if (!configResult.ok) {
    return { enabled: false, configured: true, ok: false, reason: configResult.reason, ...unconfigured };
  }
  if (!configResult.configured) {
    return { enabled: false, configured: false, ok: true, reason: 'OIDC is not configured', ...unconfigured };
  }

  const config = configResult.config;
  const createSessionStore = opts.createSessionStore || createOidcSessionStore;
  let sessionStore;
  try {
    sessionStore = createSessionStore({ dbPath: config.sessionDbPath });
  } catch (error) {
    return { enabled: false, configured: true, ok: false, reason: `the OIDC session store could not open: ${error.message}`, ...unconfigured };
  }

  const client = createOidcClient(config, { client: opts.client });
  const rbacPolicy = opts.rbacPolicy !== undefined ? opts.rbacPolicy : loadApprovalRbacPolicy();
  // The route writes the cookie and the seam reads it, so both must agree on
  // the name. A loopback deployment that opted into insecure requests gets the
  // unprefixed name in both, or the login would appear to succeed and the very
  // next request would be refused.
  const secureCookie = opts.secureCookie !== false && !config.allowInsecureRequests;
  const route = createOidcRoute({
    config: configResult,
    client,
    sessionStore,
    rbacPolicy,
    auditSink: opts.auditSink,
    secureCookie,
  });
  const authSeam = createOidcAuthSeam({
    sessionStore,
    apiKeyFallback: config.apiKeyFallback,
    allowedOrigin: config.allowedOrigin,
    secureCookie,
  });

  // `enabled` defaults to false: the feature exists but is not advertised until
  // the operator turns it on and a provider smoke test passes.
  const enabled = opts.enabled === true;

  return {
    enabled,
    configured: true,
    ok: true,
    reason: enabled ? 'OIDC is configured' : 'OIDC is configured but not advertised until a provider smoke test passes',
    isOidcPath,
    handle: route.handle,
    authorize: authSeam.authorize,
    apiKeyFallback: authSeam.apiKeyFallback,
    allowedOrigin: config.allowedOrigin,
    sessionStore,
  };
}

module.exports = { createOidcMount };
