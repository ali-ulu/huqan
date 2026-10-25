'use strict';

// Session cookie for the OIDC RP (#4267; contract in docs/sso.md).
//
// The secure cookie is `__Host-huqan-sso`: the `__Host-` prefix is a browser
// guarantee that the cookie is Secure, has Path=/ and carries no Domain, so a
// subdomain cannot set or overwrite it. On an insecure loopback deployment the
// prefix is dropped (`huqan-sso`), mirroring the viewer cookie in
// lib/viewer/session-cookie.js: a prefixed name would simply be rejected over
// http and the login would look broken.
//
// SameSite=Lax, not Strict, because the RP callback is a top-level navigation
// back from the identity provider and Strict would withhold the transaction
// cookie on that navigation. Lax is not the CSRF boundary: the contract puts
// that on an exact Origin check plus a per-session CSRF token.

const SECURE_COOKIE_NAME = '__Host-huqan-sso';
const LOOPBACK_COOKIE_NAME = 'huqan-sso';
const COOKIE_PATH = '/';

function cookieName(secure) {
  return secure ? SECURE_COOKIE_NAME : LOOPBACK_COOKIE_NAME;
}

function assertCookieValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError('sessionId must be a 32-byte base64url token');
  }
}

function cookieAttributes(secure) {
  const attributes = [`Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) attributes.push('Secure');
  return attributes;
}

function maxAgeAttribute(maxAgeSeconds) {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new TypeError('maxAgeSeconds must be a non-negative integer');
  }
  return `Max-Age=${maxAgeSeconds}`;
}

function buildSetCookie({ sessionId, secure = true, maxAgeSeconds }) {
  assertCookieValue(sessionId);
  return [
    `${cookieName(secure)}=${sessionId}`,
    ...cookieAttributes(secure),
    maxAgeAttribute(maxAgeSeconds),
  ].join('; ');
}

function buildClearCookie({ secure = true } = {}) {
  return [
    `${cookieName(secure)}=`,
    ...cookieAttributes(secure),
    'Max-Age=0',
  ].join('; ');
}

function parseSessionCookie(cookieHeader, { secure = true } = {}) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return '';
  const expectedName = cookieName(secure);
  let found;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== expectedName) continue;
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // A duplicate with a different value is a smuggling attempt, not a
    // session: refuse rather than pick one.
    if (found !== undefined && found !== value) return '';
    found = value;
  }
  return found && /^[A-Za-z0-9_-]{43}$/.test(found) ? found : '';
}

module.exports = {
  SECURE_COOKIE_NAME,
  LOOPBACK_COOKIE_NAME,
  COOKIE_PATH,
  cookieName,
  buildSetCookie,
  buildClearCookie,
  parseSessionCookie,
};
