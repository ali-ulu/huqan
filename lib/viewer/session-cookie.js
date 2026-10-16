'use strict';

const SECURE_COOKIE_NAME = '__Secure-axiom_viewer_session';
const LOOPBACK_COOKIE_NAME = 'axiom_viewer_session';
const COOKIE_PATH = '/viewer';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function cookieName(secure) {
  return secure ? SECURE_COOKIE_NAME : LOOPBACK_COOKIE_NAME;
}

function assertCookieValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError('sessionId must be a 32-byte base64url token');
  }
}

function maxAgeAttribute(maxAgeSeconds) {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new TypeError('maxAgeSeconds must be a non-negative integer');
  }
  return `Max-Age=${maxAgeSeconds}`;
}

function cookieAttributes(secure) {
  const attributes = [
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attributes.push('Secure');
  return attributes;
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
    if (found !== undefined && found !== value) return '';
    found = value;
  }
  return found && /^[A-Za-z0-9_-]{43}$/.test(found) ? found : '';
}

function isLoopback(hostname) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function isSameOriginRequest({
  originHeader,
  hostHeader,
  allowInsecureLoopback = false,
} = {}) {
  if (typeof originHeader !== 'string' || typeof hostHeader !== 'string') return false;
  if (hostHeader.includes('/') || hostHeader.includes('\\')) return false;

  try {
    const origin = new URL(originHeader);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      return false;
    }
    if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return false;

    const host = new URL(`${origin.protocol}//${hostHeader}`);
    if (host.username || host.password || host.pathname !== '/' || host.search || host.hash) {
      return false;
    }
    if (origin.host.toLowerCase() !== host.host.toLowerCase()) return false;
    if (origin.protocol === 'https:') return true;
    return allowInsecureLoopback && isLoopback(origin.hostname) && isLoopback(host.hostname);
  } catch {
    return false;
  }
}

module.exports = {
  SECURE_COOKIE_NAME,
  LOOPBACK_COOKIE_NAME,
  COOKIE_PATH,
  buildSetCookie,
  buildClearCookie,
  parseSessionCookie,
  isSameOriginRequest,
};
