// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

// The OIDC authentication seam for protected REST routes (#4267; contract in
// docs/sso.md section 5).
//
// `denyIfUnauthorized` accepts a valid API key or a valid OIDC session, but
// only the source the configured mode allows. This module is that decision,
// kept out of the composition root so it can be tested without a server.
//
// Two rules the contract states explicitly and this module enforces:
//
//   - With OIDC configured and API-key fallback off, an API key is not a
//     credential: the fallback stays off by default and enabling it is a
//     deliberate migration choice.
//   - A cookie-authenticated state-changing request requires an exact Origin
//     and the per-session CSRF token. SameSite=Lax alone is not the boundary.

const { OIDC_FAILURE_CODES } = require('./failure-codes');
const { parseSessionCookie } = require('./session-cookie');
const { CSRF_HEADER } = require('./route-constants');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * @param {object} opts
 * @param {object} opts.sessionStore - the OIDC session store
 * @param {boolean} opts.apiKeyFallback - whether an API key is still accepted
 * @param {string} opts.allowedOrigin - the exact browser origin
 * @param {boolean} [opts.secureCookie] - whether the secure cookie name is used
 * @returns {{apiKeyFallback: boolean, authorize: Function}}
 */
function createOidcAuthSeam({ sessionStore, apiKeyFallback, allowedOrigin, secureCookie = true } = {}) {
  if (!sessionStore || typeof sessionStore.validate !== 'function') {
    throw new TypeError('an OIDC session store is required');
  }

  /**
   * @returns {null} when the request carries no OIDC cookie at all
   *   | {ok: true, principal: {operatorId, role}}
   *   | {ok: false, code: string}
   */
  function authorize(req) {
    const sessionId = parseSessionCookie(req.headers?.cookie, { secure: secureCookie });
    if (!sessionId) return null;

    if (!SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) {
      const origin = req.headers?.origin;
      if (typeof origin !== 'string' || origin !== allowedOrigin) {
        return { ok: false, code: OIDC_FAILURE_CODES.CSRF_FAILED };
      }
      const csrfToken = req.headers?.[CSRF_HEADER];
      // An absent token is refused before the store call: passing `undefined`
      // makes `validate` skip the CSRF comparison entirely, so an omitted header
      // would silently disable the boundary instead of failing it.
      if (typeof csrfToken !== 'string' || !csrfToken) {
        return { ok: false, code: OIDC_FAILURE_CODES.CSRF_FAILED };
      }
      const validation = sessionStore.validate(sessionId, { csrfToken });
      if (!validation.ok) {
        return {
          ok: false,
          code: validation.reason === 'csrf_mismatch'
            ? OIDC_FAILURE_CODES.CSRF_FAILED
            : OIDC_FAILURE_CODES.SESSION_EXPIRED,
        };
      }
      return { ok: true, principal: { operatorId: validation.operatorId, role: validation.role } };
    }

    const validation = sessionStore.validate(sessionId);
    if (!validation.ok) return { ok: false, code: OIDC_FAILURE_CODES.SESSION_EXPIRED };
    return { ok: true, principal: { operatorId: validation.operatorId, role: validation.role } };
  }

  return { apiKeyFallback: apiKeyFallback === true, authorize };
}

module.exports = { createOidcAuthSeam, SAFE_METHODS };
