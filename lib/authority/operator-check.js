'use strict';

// The approval authority's operator check: a TOTP code under a failure limit
// (#3860, ADR-016 items 3 and 7).
//
// Three candidate steps make a random six-digit guess succeed about three times
// in a million, which is only safe if guessing is slow. Five failures inside
// five minutes lock decisions for fifteen; while locked even a right code is
// refused and changes nothing. A malformed code is a failure like any other, so
// it cannot be used to probe for free. The function is pure: the caller
// persists the returned progress before acting on the answer.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const { verifyTotp } = require('./totp');

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * @returns {{ok: true, progress: object, counter: number}
 *   | {ok: false, code: 'LOCKED'|'TOTP_INVALID'|'TOTP_REPLAYED', progress: object, lockedNow: boolean}}
 */
function checkOperatorCode({ secret, code, now, progress }) {
  if (progress.lockedUntil !== null && now < progress.lockedUntil) {
    return { ok: false, code: 'LOCKED', progress, lockedNow: false };
  }
  const result = verifyTotp({ secret, code, now, lastCounter: progress.lastCounter });
  if (result.ok) {
    return { ok: true, counter: result.counter, progress: { lastCounter: result.counter, failures: [], lockedUntil: null } };
  }
  const failures = [...progress.failures.filter(at => now - at <= FAILURE_WINDOW_MS), now];
  const lockedNow = failures.length >= MAX_FAILURES;
  const next = { lastCounter: progress.lastCounter, failures, lockedUntil: lockedNow ? now + LOCKOUT_MS : null };
  const failure = result.reason === 'replayed' ? 'TOTP_REPLAYED' : 'TOTP_INVALID';
  return { ok: false, code: lockedNow ? 'LOCKED' : failure, progress: next, lockedNow };
}

module.exports = { MAX_FAILURES, FAILURE_WINDOW_MS, LOCKOUT_MS, checkOperatorCode };
