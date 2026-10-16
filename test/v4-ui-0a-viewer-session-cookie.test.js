'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  SECURE_COOKIE_NAME,
  LOOPBACK_COOKIE_NAME,
  buildSetCookie,
  buildClearCookie,
  parseSessionCookie,
  isSameOriginRequest,
} = require('../lib/viewer/session-cookie');

const SESSION_ID = 'A'.repeat(43);

describe('V4-UI-0A viewer session cookie', () => {
  it('builds a viewer-scoped secure cookie with bounded lifetime', () => {
    assert.equal(
      buildSetCookie({ sessionId: SESSION_ID, maxAgeSeconds: 900 }),
      `${SECURE_COOKIE_NAME}=${SESSION_ID}; Path=/viewer; HttpOnly; SameSite=Strict; Secure; Max-Age=900`,
    );
  });

  it('uses a distinct non-Secure name only for an explicit loopback policy', () => {
    assert.equal(
      buildSetCookie({ sessionId: SESSION_ID, secure: false, maxAgeSeconds: 60 }),
      `${LOOPBACK_COOKIE_NAME}=${SESSION_ID}; Path=/viewer; HttpOnly; SameSite=Strict; Max-Age=60`,
    );
  });

  it('clears a cookie with the same security attributes', () => {
    assert.equal(
      buildClearCookie(),
      `${SECURE_COOKIE_NAME}=; Path=/viewer; HttpOnly; SameSite=Strict; Secure; Max-Age=0`,
    );
    assert.equal(
      buildClearCookie({ secure: false }),
      `${LOOPBACK_COOKIE_NAME}=; Path=/viewer; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
  });

  it('rejects cookie header injection and invalid max age', () => {
    assert.throws(
      () => buildSetCookie({ sessionId: `${SESSION_ID}\r\nInjected: yes`, maxAgeSeconds: 1 }),
      /sessionId/,
    );
    assert.throws(() => buildSetCookie({ sessionId: SESSION_ID, maxAgeSeconds: -1 }), /maxAge/);
  });

  it('parses matching cookies and tolerates equivalent duplicates', () => {
    assert.equal(
      parseSessionCookie(`other=x; ${SECURE_COOKIE_NAME}=${SESSION_ID}`),
      SESSION_ID,
    );
    assert.equal(
      parseSessionCookie(`${SECURE_COOKIE_NAME}="${SESSION_ID}"; ${SECURE_COOKIE_NAME}=${SESSION_ID}`),
      SESSION_ID,
    );
  });

  it('fails closed for absent, malformed, or conflicting duplicate cookies', () => {
    assert.equal(parseSessionCookie(undefined), '');
    assert.equal(parseSessionCookie('other=x'), '');
    assert.equal(parseSessionCookie(`${SECURE_COOKIE_NAME}=short`), '');
    assert.equal(
      parseSessionCookie(`${SECURE_COOKIE_NAME}=${SESSION_ID}; ${SECURE_COOKIE_NAME}=${'B'.repeat(43)}`),
      '',
    );
  });

  it('keeps secure and loopback cookie names separate', () => {
    assert.equal(parseSessionCookie(`${LOOPBACK_COOKIE_NAME}=${SESSION_ID}`), '');
    assert.equal(
      parseSessionCookie(`${LOOPBACK_COOKIE_NAME}=${SESSION_ID}`, { secure: false }),
      SESSION_ID,
    );
  });

  it('accepts an exact HTTPS origin and Host match', () => {
    assert.equal(isSameOriginRequest({
      originHeader: 'https://viewer.example:8443',
      hostHeader: 'viewer.example:8443',
    }), true);
  });

  it('rejects missing, malformed, cross-host, cross-port, and insecure origins', () => {
    assert.equal(isSameOriginRequest(), false);
    assert.equal(isSameOriginRequest({ originHeader: 'null', hostHeader: 'viewer.example' }), false);
    assert.equal(isSameOriginRequest({
      originHeader: 'https://evil.example',
      hostHeader: 'viewer.example',
    }), false);
    assert.equal(isSameOriginRequest({
      originHeader: 'https://viewer.example:8443',
      hostHeader: 'viewer.example:9443',
    }), false);
    assert.equal(isSameOriginRequest({
      originHeader: 'http://viewer.example',
      hostHeader: 'viewer.example',
    }), false);
    assert.equal(isSameOriginRequest({
      originHeader: 'https://viewer.example',
      hostHeader: 'evil.example@viewer.example',
    }), false);
    assert.equal(isSameOriginRequest({
      originHeader: 'https://viewer.example',
      hostHeader: 'viewer.example?ignored=true',
    }), false);
  });

  it('allows explicit HTTP loopback without allowing non-loopback HTTP', () => {
    assert.equal(isSameOriginRequest({
      originHeader: 'http://127.0.0.1:3000',
      hostHeader: '127.0.0.1:3000',
      allowInsecureLoopback: true,
    }), true);
    assert.equal(isSameOriginRequest({
      originHeader: 'http://viewer.example:3000',
      hostHeader: 'viewer.example:3000',
      allowInsecureLoopback: true,
    }), false);
    assert.equal(isSameOriginRequest({
      originHeader: 'http://localhost:3000',
      hostHeader: 'localhost:3000',
      allowInsecureLoopback: true,
    }), true);
    assert.equal(isSameOriginRequest({
      originHeader: 'http://[::1]:3000',
      hostHeader: '[::1]:3000',
      allowInsecureLoopback: true,
    }), true);
  });

  it('normalizes default HTTPS ports without broadening the origin', () => {
    assert.equal(isSameOriginRequest({
      originHeader: 'https://viewer.example',
      hostHeader: 'viewer.example:443',
    }), true);
    assert.equal(isSameOriginRequest({
      originHeader: 'http://127.0.0.1:3000',
      hostHeader: '127.0.0.1:3000',
    }), false);
  });
});
