// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

// OIDC Relying Party HTTP routes (#4267; contract in docs/sso.md).
//
// Four endpoints, all reachable before authentication:
//   GET  /auth/oidc/login    - start the Authorization Code + PKCE flow
//   GET  /auth/oidc/callback - exchange the code and create the session
//   GET  /auth/session       - return the minimum UI identity
//   POST /auth/logout        - revoke the session
//
// The paths are the ones docs/sso.md names. The issue text writes them without
// the `oidc/` segment; the merged contract wins, and no alias is registered, so
// there is exactly one login path to reason about.
//
// No issuer, discovery URL, JWKS URL, redirect URI or callback destination is
// read from a request parameter. The only request input the flow trusts is the
// authorization code, the state it was bound to, and the CSRF token for a
// cookie-authenticated state change -- each of which is validated before it is
// used, and each refusal maps to one stable failure code.
//
// The route never returns an ID token, access token, client secret, session
// identifier or private key. A cookie-authenticated state change additionally
// requires an exact Origin and the per-session CSRF token, because
// SameSite=Lax is not the CSRF boundary.

const crypto = require('node:crypto');
const { OIDC_FAILURE_CODES } = require('./failure-codes');
const { mapOidcPrincipal } = require('./identity-mapping');
const { createOidcTransactionStore } = require('./transaction-store');
const { buildSetCookie, buildClearCookie, parseSessionCookie } = require('./session-cookie');
const { classifyGrantError } = require('./client');
const { loadApprovalRbacPolicy } = require('../approval-rbac');
const {
  LOGIN_PATH,
  CALLBACK_PATH,
  SESSION_PATH,
  LOGOUT_PATH,
  OIDC_PATHS,
  CSRF_HEADER,
  POST_LOGIN_PATH,
  isOidcPath,
} = require('./route-constants');

/**
 * An exact origin match. A request with no Origin header is refused for a
 * state change: an absent Origin is what a form post from a foreign page
 * looks like, and "same-origin" cannot be asserted without it.
 */
function isAllowedOrigin(req, allowedOrigin) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || !origin) return false;
  return origin === allowedOrigin;
}

function createOidcRoute({
  config,
  client,
  sessionStore,
  auditSink,
  now = Date.now,
  transactionStore,
  rbacPolicy,
  secureCookie = true,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!config || config.configured !== true || config.ok !== true) {
    throw new TypeError('OIDC config must be configured and valid');
  }
  if (!client || typeof client.buildAuthorizationUrl !== 'function') {
    throw new TypeError('an OIDC client is required');
  }
  if (!sessionStore || typeof sessionStore.create !== 'function') {
    throw new TypeError('sessionStore is required');
  }
  const settings = config.config;
  const transactions = transactionStore || createOidcTransactionStore({ now, randomBytes });
  const policy = rbacPolicy !== undefined ? rbacPolicy : loadApprovalRbacPolicy();

  function writeJson(res, status, body, headers = {}) {
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    }
    res.end(JSON.stringify(body));
  }

  function audit(eventType, details) {
    if (typeof auditSink === 'function') {
      try {
        auditSink({ eventType, details, actor: 'oidc-rp', workspaceId: 'default', timestamp: new Date().toISOString() });
      } catch {
        // An audit failure must not break the login path.
      }
    }
  }

  function refuse(res, status, code, message) {
    audit('OIDC_LOGIN_REFUSED', { code });
    writeJson(res, status, { ok: false, error: { code, message } });
  }

  // The secure cookie is the default. A loopback deployment that opted into
  // insecure requests gets the unprefixed cookie name, because a `__Host-`
  // cookie is rejected over http and the login would look broken.
  const secureCookieName = secureCookie && !settings.allowInsecureRequests;

  async function handleLogin(req, res) {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'login accepts GET only' } }, { Allow: 'GET' });
      return true;
    }
    const transaction = transactions.begin();
    let authorizationUrl;
    try {
      const codeChallenge = await client.calculatePkceChallenge(transaction.codeVerifier);
      authorizationUrl = await client.buildAuthorizationUrl({
        state: transaction.state,
        nonce: transaction.nonce,
        codeChallenge,
      });
    } catch {
      refuse(res, 503, OIDC_FAILURE_CODES.DISCOVERY_FAILED, 'the identity provider could not be reached');
      return true;
    }
    res.writeHead(302, { Location: authorizationUrl.toString(), 'Cache-Control': 'no-store' });

    res.end();
    return true;
  }

  async function handleCallback(req, res, reqUrl) {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'callback accepts GET only' } }, { Allow: 'GET' });
      return true;
    }
    // The provider may report a failure in the query string.
    if (reqUrl.searchParams.get('error')) {
      refuse(res, 401, OIDC_FAILURE_CODES.STATE_INVALID, 'the identity provider refused the authorization request');
      return true;
    }
    const state = reqUrl.searchParams.get('state');
    const transaction = transactions.consume(state);
    if (!transaction) {
      refuse(res, 400, OIDC_FAILURE_CODES.STATE_INVALID, 'the login state is missing, expired or already used');
      return true;
    }
    const code = reqUrl.searchParams.get('code');
    if (typeof code !== 'string' || !code) {
      refuse(res, 400, OIDC_FAILURE_CODES.STATE_INVALID, 'the callback carried no authorization code');
      return true;
    }

    let result;
    try {
      result = await client.exchange(reqUrl, {
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
    } catch (error) {
      refuse(res, 401, classifyGrantError(error), 'the identity token could not be validated');
      return true;
    }

    const mapped = mapOidcPrincipal(result.claims, {
      mapping: settings.identityMapping,
      issuer: settings.issuer,
      rbacPolicy: policy,
    });
    if (!mapped.ok) {
      refuse(res, 403, OIDC_FAILURE_CODES.CLAIM_MAPPING_DENIED, mapped.message);
      return true;
    }

    const session = sessionStore.create({ principal: mapped.principal });
    audit('OIDC_LOGIN', { operatorId: mapped.principal.operatorId, role: mapped.principal.role });
    res.writeHead(302, {
      Location: POST_LOGIN_PATH,
      'Cache-Control': 'no-store',
      'Set-Cookie': buildSetCookie({
        sessionId: session.sessionId,
        secure: secureCookieName,
        maxAgeSeconds: session.maxAgeSeconds,
      }),
    });
    res.end();
    return true;
  }

  function handleSession(req, res) {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'session accepts GET only' } }, { Allow: 'GET' });
      return true;
    }
    const sessionId = parseSessionCookie(req.headers?.cookie, { secure: secureCookieName });
    const validation = sessionStore.validate(sessionId);
    if (!validation.ok) {
      refuse(res, 401, OIDC_FAILURE_CODES.SESSION_EXPIRED, 'a valid session is required');
      return true;
    }
    writeJson(res, 200, {
      ok: true,
      operatorId: validation.operatorId,
      role: validation.role,
      expiresAt: validation.expiresAt,
      csrfToken: validation.csrfToken,
    });
    return true;
  }

  function handleLogout(req, res) {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'logout accepts POST only' } }, { Allow: 'POST' });
      return true;
    }
    if (!isAllowedOrigin(req, settings.allowedOrigin)) {
      refuse(res, 403, OIDC_FAILURE_CODES.CSRF_FAILED, 'a same-origin request is required');
      return true;
    }
    const sessionId = parseSessionCookie(req.headers?.cookie, { secure: secureCookieName });
    const csrfToken = req.headers?.[CSRF_HEADER];
    // An absent header must be refused, not passed as `undefined`: a validation
    // call that omits the token skips the CSRF check altogether, which would
    // make the boundary opt-out for any caller that simply does not send it.
    if (typeof csrfToken !== 'string' || !csrfToken) {
      refuse(res, 403, OIDC_FAILURE_CODES.CSRF_FAILED, 'the CSRF token is required');
      return true;
    }
    const validation = sessionStore.validate(sessionId, { csrfToken });
    if (!validation.ok) {
      refuse(res, 403, validation.reason === 'csrf_mismatch' ? OIDC_FAILURE_CODES.CSRF_FAILED : OIDC_FAILURE_CODES.SESSION_EXPIRED,
        validation.reason === 'csrf_mismatch' ? 'the CSRF token is invalid' : 'a valid session is required');
      return true;
    }
    sessionStore.revoke(sessionId);
    audit('OIDC_LOGOUT', { operatorId: validation.operatorId });
    res.writeHead(204, { 'Cache-Control': 'no-store', 'Set-Cookie': buildClearCookie({ secure: secureCookieName }) });
    res.end();
    return true;
  }

  function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (pathname === LOGIN_PATH) return handleLogin(req, res);
    if (pathname === CALLBACK_PATH) return handleCallback(req, res, reqUrl);
    if (pathname === SESSION_PATH) return handleSession(req, res);
    if (pathname === LOGOUT_PATH) return handleLogout(req, res);
    return false;
  }

  return {
    isOidcPath,
    handle,
    _transactions: transactions,
    _paths: OIDC_PATHS,
  };
}

module.exports = {
  LOGIN_PATH,
  CALLBACK_PATH,
  SESSION_PATH,
  LOGOUT_PATH,
  OIDC_PATHS,
  CSRF_HEADER,
  POST_LOGIN_PATH,
  isOidcPath,
  isAllowedOrigin,
  createOidcRoute,
};
