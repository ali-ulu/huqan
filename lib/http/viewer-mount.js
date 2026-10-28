'use strict';

// Mounted from server.js by #2128. The viewer UI (session store + gateway)
// plus its per-IP rate limiter move here verbatim so the composition root
// keeps wiring only. No kernel decisions live here: the gateway receives its
// readReceipt callback, the limiter is a self-contained token bucket.

const { createSessionStore } = require('../viewer/session-store');
const { createViewerGateway } = require('../viewer/viewer-gateway');
const { loadEnterpriseModule } = require('../enterprise-module');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');

// SSO is an Enterprise feature (LICENSE-ENTERPRISE). Without its files the
// viewer claims no SAML or OIDC path, exactly as when SSO is not configured.
const NO_SAML = Object.freeze({ isSamlPath: () => false, handle: () => false });
const NO_OIDC = Object.freeze({
  enabled: false, configured: false, ok: true, reason: 'OIDC Enterprise files are not installed', isOidcPath: () => false,
});
// The variables lib/oidc/config.js treats as "OIDC is configured" (any one set).
// A deployment that sets one but lacks the OIDC files must stay fail-closed:
// configured, unusable, no API-key fallback -- as for a broken configuration.
const OIDC_CONFIG_ENV = Object.freeze([
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OIDC_IDENTITY_MAPPING_PATH', 'OIDC_SESSION_DB_PATH',
]);
const OIDC_FILES_MISSING = Object.freeze({
  enabled: false, configured: true, ok: false, reason: 'OIDC is configured but its Enterprise files are not installed', isOidcPath: () => false,
});

function oidcConfiguredInEnvironment(readEnvironment = readCompatibleEnvironmentVariable) {
  return OIDC_CONFIG_ENV.some((name) => {
    const value = readEnvironment(name);
    return value !== undefined && value !== null && value !== '';
  });
}

function samlRouteFor(sessionStore) {
  const saml = loadEnterpriseModule('./saml/sp-route');
  return saml ? saml.createSamlSpFromEnv({ sessionStore }) : NO_SAML;
}

function defaultOidcMount() {
  const oidc = loadEnterpriseModule('./oidc/mount');
  if (oidc) return oidc.createOidcMount();
  return oidcConfiguredInEnvironment() ? OIDC_FILES_MISSING : NO_OIDC;
}

const VIEWER_RATE_LIMIT_WINDOW_MS = 60_000;
const VIEWER_RATE_LIMIT_MAX = 120;
const VIEWER_RATE_LIMIT_MAX_ENTRIES = 2048;

function createViewerRateLimiter({
  windowMs = VIEWER_RATE_LIMIT_WINDOW_MS,
  max = VIEWER_RATE_LIMIT_MAX,
  maxEntries = VIEWER_RATE_LIMIT_MAX_ENTRIES,
} = {}) {
  const records = new Map();

  function check(req, timestamp = Date.now()) {
    const key = String(req.socket?.remoteAddress || 'unknown');
    let record = records.get(key);
    if (record && timestamp >= record.resetAt) {
      records.delete(key);
      record = null;
    }
    if (!record) {
      if (records.size >= maxEntries) {
        for (const [candidate, entry] of records) {
          if (timestamp >= entry.resetAt) records.delete(candidate);
        }
      }
      if (records.size >= maxEntries) return false;
      record = { count: 0, resetAt: timestamp + windowMs };
      records.set(key, record);
    }
    record.count += 1;
    return record.count <= max;
  }

  function reset() {
    records.clear();
  }

  return { check, reset };
}

/**
 * @param {object} deps - { readReceipt } (kernel.graph reader, supplied by the root)
 */
function createViewerMount({ readReceipt, oidc } = {}) {
  const sessionStore = createSessionStore();
  const gateway = createViewerGateway({ sessionStore, readReceipt });
  const samlRoute = samlRouteFor(sessionStore);
  const oidcMount = oidc === undefined ? defaultOidcMount() : oidc;
  const limiter = createViewerRateLimiter();

  return {
    isViewerPath: (rawPath) => gateway.isViewerPath(rawPath) || samlRoute.isSamlPath(rawPath) || oidcMount.isOidcPath(rawPath),
    checkRateLimit: (req, timestamp) => limiter.check(req, timestamp),
    handle: (req, res, reqUrl) => {
      if (samlRoute.handle(req, res, reqUrl)) return true;
      if (oidcMount.handle && oidcMount.handle(req, res, reqUrl)) return true;
      return gateway.handle(req, res, reqUrl);
    },
    // The OIDC mount is exposed so the composition root can consult its auth
    // seam in denyIfUnauthorized. One session store, one auth seam: the OIDC
    // session authenticates protected REST routes through the same gate the
    // API key does, rather than through a second authorization system.
    oidcMount,
    reset: () => {
      limiter.reset();
      sessionStore.reset();
      try { oidcMount.sessionStore?.close(); } catch (_) {}
    },
  };
}

module.exports = {
  createViewerMount,
  createViewerRateLimiter,
  VIEWER_RATE_LIMIT_WINDOW_MS,
  VIEWER_RATE_LIMIT_MAX,
  VIEWER_RATE_LIMIT_MAX_ENTRIES,
};
