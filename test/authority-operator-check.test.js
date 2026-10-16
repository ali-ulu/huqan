'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { checkOperatorCode, MAX_FAILURES, LOCKOUT_MS, FAILURE_WINDOW_MS } = require('../lib/authority/operator-check');

const SECRET = Buffer.from('12345678901234567890', 'ascii');
const NOW = 1111111111 * 1000;
const COUNTER = Math.floor(NOW / 1000 / TOTP_STEP_SECONDS);
const FRESH = Object.freeze({ lastCounter: -1, failures: [], lockedUntil: null });

test('a valid code is accepted and its step becomes the replay floor', () => {
  const result = checkOperatorCode({ secret: SECRET, code: totpAt(SECRET, COUNTER), now: NOW, progress: FRESH });
  assert.equal(result.ok, true);
  assert.deepEqual(result.progress, { lastCounter: COUNTER, failures: [], lockedUntil: null });
  const again = checkOperatorCode({ secret: SECRET, code: totpAt(SECRET, COUNTER), now: NOW, progress: result.progress });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'TOTP_REPLAYED');
});

test('the fifth failure inside the window locks the operator out, and the lock holds even for a right code', () => {
  let progress = FRESH;
  for (let i = 1; i <= MAX_FAILURES; i += 1) {
    const result = checkOperatorCode({ secret: SECRET, code: '000000', now: NOW + i, progress });
    assert.equal(result.ok, false);
    assert.equal(result.code, i < MAX_FAILURES ? 'TOTP_INVALID' : 'LOCKED', `attempt ${i}`);
    assert.equal(result.lockedNow, i === MAX_FAILURES);
    progress = result.progress;
  }
  assert.equal(progress.lockedUntil, NOW + MAX_FAILURES + LOCKOUT_MS);
  const right = checkOperatorCode({ secret: SECRET, code: totpAt(SECRET, COUNTER), now: NOW + 10, progress });
  assert.deepEqual([right.ok, right.code], [false, 'LOCKED']);
  assert.deepEqual(right.progress, progress, 'a locked attempt changes nothing');
});

test('failures older than the window do not count toward a lockout', () => {
  const old = Array.from({ length: MAX_FAILURES - 1 }, (_, i) => NOW - FAILURE_WINDOW_MS - 1 - i);
  const result = checkOperatorCode({ secret: SECRET, code: '000000', now: NOW, progress: { ...FRESH, failures: old } });
  assert.equal(result.code, 'TOTP_INVALID');
  assert.deepEqual(result.progress.failures, [NOW]);
});

test('the lock lifts once its time has passed', () => {
  const later = (Math.floor(NOW / 1000) + LOCKOUT_MS / 1000 + 60) * 1000;
  const counter = Math.floor(later / 1000 / TOTP_STEP_SECONDS);
  const progress = { lastCounter: -1, failures: [NOW], lockedUntil: NOW + LOCKOUT_MS };
  const result = checkOperatorCode({ secret: SECRET, code: totpAt(SECRET, counter), now: later, progress });
  assert.equal(result.ok, true);
  assert.equal(result.progress.lockedUntil, null);
});

test('a malformed code counts as a failure, so it cannot be used to probe without cost', () => {
  const result = checkOperatorCode({ secret: SECRET, code: 'abc', now: NOW, progress: FRESH });
  assert.deepEqual([result.ok, result.code, result.progress.failures], [false, 'TOTP_INVALID', [NOW]]);
});
