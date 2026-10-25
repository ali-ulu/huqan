'use strict';

// OIDC Relying Party configuration (#4267; contract in docs/sso.md).
//
// Every value that decides trust comes from the deployment environment and
// nothing else: the issuer, the client credentials, the registered redirect
// URI, the identity mapping file, the session database, the browser origin,
// and the two switches (API-key fallback, loopback override). No issuer,
// discovery URL, JWKS URL, redirect URI or callback destination is ever read
// from a request parameter, so a caller cannot point the RP at an identity
// provider of their choosing.
//
// Absent configuration is not an error: the deployment keeps the API-key-only
// behaviour it had before this slice. Partial configuration refuses startup,
// because half an RP cannot fail closed.

const fs = require('node:fs');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');

const OIDC_ISSUER_ENV = 'OIDC_ISSUER';
const OIDC_CLIENT_ID_ENV = 'OIDC_CLIENT_ID';
const OIDC_CLIENT_SECRET_ENV = 'OIDC_CLIENT_SECRET';
const OIDC_REDIRECT_URI_ENV = 'OIDC_REDIRECT_URI';
const OIDC_IDENTITY_MAPPING_PATH_ENV = 'OIDC_IDENTITY_MAPPING_PATH';
const OIDC_SESSION_DB_PATH_ENV = 'OIDC_SESSION_DB_PATH';
const OIDC_API_KEY_FALLBACK_ENV = 'OIDC_API_KEY_FALLBACK';
const OIDC_ALLOWED_ORIGIN_ENV = 'OIDC_ALLOWED_ORIGIN';
const OIDC_INSECURE_LOOPBACK_ENV = 'OIDC_INSECURE_LOOPBACK';

const REQUIRED_ENV = Object.freeze([
  OIDC_ISSUER_ENV,
  OIDC_CLIENT_ID_ENV,
  OIDC_CLIENT_SECRET_ENV,
  OIDC_REDIRECT_URI_ENV,
  OIDC_IDENTITY_MAPPING_PATH_ENV,
  OIDC_SESSION_DB_PATH_ENV,
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

/**
 * An absolute URL with no userinfo, query, fragment or traversal. HTTPS is
 * required unless the deployment deliberately opted into a loopback mock IdP,
 * in which case plain HTTP is accepted only for a loopback hostname.
 */
function validateUrl(raw, { allowInsecure, field }) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: `${field} must be an absolute URL` };
  }
  if (url.username || url.password) return { ok: false, reason: `${field} must not carry userinfo` };
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && allowInsecure && isLoopbackHostname(url.hostname)) {
    return { ok: true, url };
  }
  return { ok: false, reason: `${field} must use HTTPS` };
}

function invalid(reason) {
  return { configured: true, ok: false, reason };
}

/**
 * @returns {{configured: false, ok: true}
 *   | {configured: true, ok: false, reason: string}
 *   | {configured: true, ok: true, config: object}}
 */
function loadOidcConfig({
  readEnvironment = readCompatibleEnvironmentVariable,
  readFile = fs.readFileSync,
} = {}) {
  const present = REQUIRED_ENV.filter((name) => {
    const value = readEnvironment(name);
    return value !== undefined && value !== null && value !== '';
  });
  if (present.length === 0) return { configured: false, ok: true };
  if (present.length !== REQUIRED_ENV.length) {
    const missing = REQUIRED_ENV.filter((name) => !present.includes(name));
    return invalid(`OIDC is partially configured; missing ${missing.join(', ')}`);
  }

  const insecure = readEnvironment(OIDC_INSECURE_LOOPBACK_ENV) === '1';

  const issuer = validateUrl(readEnvironment(OIDC_ISSUER_ENV), {
    allowInsecure: insecure,
    field: 'the OIDC issuer',
  });
  if (!issuer.ok) return invalid(issuer.reason);

  const redirect = validateUrl(readEnvironment(OIDC_REDIRECT_URI_ENV), {
    allowInsecure: insecure,
    field: 'the OIDC redirect URI',
  });
  if (!redirect.ok) return invalid(redirect.reason);
  if (redirect.url.search || redirect.url.hash) {
    return invalid('the OIDC redirect URI must not carry a query or fragment');
  }

  const clientId = String(readEnvironment(OIDC_CLIENT_ID_ENV));
  if (clientId.length > 512) return invalid('the OIDC client id is too long');
  const clientSecret = String(readEnvironment(OIDC_CLIENT_SECRET_ENV));
  if (clientSecret.length > 1024) return invalid('the OIDC client secret is too long');

  const mappingFile = String(readEnvironment(OIDC_IDENTITY_MAPPING_PATH_ENV));
  let mapping;
  try {
    mapping = JSON.parse(readFile(mappingFile, 'utf8'));
  } catch (error) {
    return invalid(`the identity mapping ${mappingFile} is unreadable: ${error.message}`);
  }

  const sessionDbPath = String(readEnvironment(OIDC_SESSION_DB_PATH_ENV));
  if (!sessionDbPath) return invalid('the OIDC session database path is empty');

  // The mapping's issuer must equal the configured issuer: two sources of
  // truth for the same value is how a token from one provider is mapped with
  // another provider's group table.
  if (typeof mapping.issuer !== 'string' || mapping.issuer !== issuer.url.href) {
    return invalid('the identity mapping issuer must equal the configured OIDC issuer');
  }

  const allowedOriginRaw = readEnvironment(OIDC_ALLOWED_ORIGIN_ENV);
  const allowedOrigin = validateUrl(allowedOriginRaw || redirect.url.origin, {
    allowInsecure: insecure,
    field: 'the allowed browser origin',
  });
  if (!allowedOrigin.ok) return invalid(allowedOrigin.reason);
  if (allowedOrigin.url.pathname !== '/' || allowedOrigin.url.search || allowedOrigin.url.hash) {
    return invalid('the allowed browser origin must be an origin, not a path');
  }

  return {
    configured: true,
    ok: true,
    config: Object.freeze({
      issuer: issuer.url.href,
      issuerUrl: issuer.url,
      clientId,
      clientSecret,
      redirectUri: redirect.url.href,
      redirectPath: redirect.url.pathname,
      identityMappingPath: mappingFile,
      identityMapping: Object.freeze(mapping),
      sessionDbPath,
      allowedOrigin: allowedOrigin.url.origin,
      apiKeyFallback: readEnvironment(OIDC_API_KEY_FALLBACK_ENV) === '1',
      allowInsecureRequests: insecure,
    }),
  };
}

module.exports = {
  OIDC_ISSUER_ENV,
  OIDC_CLIENT_ID_ENV,
  OIDC_CLIENT_SECRET_ENV,
  OIDC_REDIRECT_URI_ENV,
  OIDC_IDENTITY_MAPPING_PATH_ENV,
  OIDC_SESSION_DB_PATH_ENV,
  OIDC_API_KEY_FALLBACK_ENV,
  OIDC_ALLOWED_ORIGIN_ENV,
  OIDC_INSECURE_LOOPBACK_ENV,
  REQUIRED_ENV,
  isLoopbackHostname,
  validateUrl,
  loadOidcConfig,
};
