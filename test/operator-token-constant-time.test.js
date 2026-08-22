'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { operatorAuthorized } = require('../lib/http/pr-guardian-routes');
const { constantTimeEqual } = require('../requestGuards');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Operator tokens are variable-length secrets, so their comparison must not
 * branch on length.
 *
 * `configured.length === presented.length && crypto.timingSafeEqual(...)`
 * short-circuits: on a length mismatch the comparison never runs and the call
 * returns measurably sooner, which leaks the configured token's length and lets
 * an attacker shrink the search space. requestGuards.constantTimeEqual hashes
 * both operands first, so the compared buffers are always 32 bytes (#1038).
 */

test('operator token comparison accepts only the exact token, at any guess length', () => {
  const secret = 'operator-token-abcdefghijklmnop';
  const compare = [
    ['pr-guardian', operatorAuthorized],
    ['requestGuards', constantTimeEqual],
  ];

  for (const [name, fn] of compare) {
    assert.equal(fn(secret, secret), true, `${name} accepts the exact token`);
    // A near-miss of the same length.
    assert.equal(fn(secret, `${secret.slice(0, -1)}X`), false, `${name} same-length mismatch`);
    // Guesses shorter and longer than the secret must be refused the same way.
    assert.equal(fn(secret, secret.slice(0, 4)), false, `${name} short guess`);
    assert.equal(fn(secret, `${secret}extra`), false, `${name} long guess`);
    assert.equal(fn(secret, ''), false, `${name} empty guess`);
  }

  assert.equal(operatorAuthorized('', 'anything'), false, 'unconfigured token authorizes nobody');
  assert.equal(operatorAuthorized('operator-secret', ''), false);
});

test('no operator-token comparison guards timingSafeEqual with a length check (#1038)', () => {
  // The defect was three copies of one leaky rule, so this asserts on the
  // sources rather than on one function: a `length ===` immediately in front of
  // timingSafeEqual is the shape that short-circuits.
  //
  // The two HMAC comparisons are deliberately exempt. They compare fixed-size
  // digests -- 32 raw bytes, or `sha256=` plus 64 hex characters, both validated
  // for shape beforehand -- so there is no secret length for the check to leak.
  const HMAC_EXEMPT = new Set([
    'lib/github-app-beta-auth.js',
    'lib/http/pr-guardian-routes.js',
  ]);

  const files = [
    'mcpServer.js',
    'requestGuards.js',
    'lib/http/memory-approval-routes.js',
    'lib/http/pr-guardian-routes.js',
    'lib/github-app-beta-auth.js',
    'lib/viewer/viewer-gateway.js',
  ];

  const offenders = [];
  for (const file of files) {
    if (HMAC_EXEMPT.has(file)) continue;
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    source.split('\n').forEach((line, index) => {
      if (/\.length\s*===\s*\w+\.length\s*&&[\s\S]*timingSafeEqual/.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(offenders, [], `length-guarded timingSafeEqual found at: ${offenders.join(', ')}`);
});

test('mcpServer routes its operator check through the shared helper (#1038)', () => {
  // isMcpOperatorAuthorized is module-private, so this pins the wiring.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'mcpServer.js'), 'utf8');
  assert.match(source, /require\('\.\/requestGuards'\)/, 'mcpServer must import the shared helper');
  assert.match(
    source,
    /function isMcpOperatorAuthorized[\s\S]{0,600}?constantTimeEqual\(configuredToken, presentedToken\)/,
    'isMcpOperatorAuthorized must compare through constantTimeEqual',
  );
});
