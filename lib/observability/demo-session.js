'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'huqan_observability_demo';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function createObservabilityDemoSession({ token = '' } = {}) {
  const configured = String(token || '');
  const validConfiguration = TOKEN_PATTERN.test(configured);

  function matches(req) {
    if (!validConfiguration || !isLoopbackRequest(req)) return false;
    const cookieHeader = String(req.headers?.cookie || '');
    const cookie = cookieHeader.split(';').map(value => value.trim())
      .find(value => value.startsWith(`${COOKIE_NAME}=`));
    if (!cookie) return false;
    const presented = cookie.slice(COOKIE_NAME.length + 1);
    if (!TOKEN_PATTERN.test(presented) || presented.length !== configured.length) return false;
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(configured));
  }

  function cookieFor(req) {
    if (!validConfiguration || !isLoopbackRequest(req)) return null;
    return `${COOKIE_NAME}=${configured}; HttpOnly; SameSite=Strict; Path=/api/observability; Max-Age=3600`;
  }

  function pageHeaders(req) {
    const cookie = cookieFor(req);
    return cookie ? { 'Set-Cookie': cookie } : {};
  }

  return Object.freeze({ matches, pageHeaders });
}

module.exports = { COOKIE_NAME, createObservabilityDemoSession, isLoopbackRequest };
