// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

// One-time consumption of SAML assertion/request identifiers (#4214).
//
// A SAML AuthnResponse is replayable by definition: it is a bearer token
// signed by the IdP. The SP closes that door with a bounded set of consumed
// identifiers — an assertion ID or an InResponseTo value presented twice is
// refused the second time, and the set forgets old entries after their
// assertion windows can no longer be valid. The store is in-memory; a restart
// resets it, which is acceptable because the assertions themselves expire
// (NotOnOrAfter) and the session created from them is destroyed on logout.
//
// The bound is deliberately small: the set only holds identifiers that were
// seen within the lookback window, and the cap evicts the oldest on overflow
// so a flood cannot grow memory.

const MAX_CONSUMED = 10_000;

function normalizeId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (/[^A-Za-z0-9_.:@-]/ .test(value)) return null;
  return value;
}

function createSamlReplayStore({ now = Date.now, maxLookbackMs = 15 * 60 * 1000 } = {}) {
  const entries = new Map(); // id -> expiry timestamp (ms)

  function sweep(timestamp) {
    for (const [id, expiry] of entries) {
      if (timestamp >= expiry) entries.delete(id);
    }
  }

  return {
    /**
     * Claim an identifier for one-time use.
     * @returns {{ok: true} | {ok: false, code: 'replayed'|'malformed_id'}}
     */
    consume(id) {
      const normalized = normalizeId(id);
      if (!normalized) return { ok: false, code: 'malformed_id' };
      const timestamp = now();
      sweep(timestamp);
      if (entries.has(normalized)) return { ok: false, code: 'replayed' };
      if (entries.size >= MAX_CONSUMED) {
        let oldest;
        let oldestExpiry = Infinity;
        for (const [key, expiry] of entries) {
          if (expiry < oldestExpiry) {
            oldest = key;
            oldestExpiry = expiry;
          }
        }
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(normalized, timestamp + maxLookbackMs);
      return { ok: true };
    },
    size: () => entries.size,
    reset: () => { entries.clear(); },
  };
}

module.exports = {
  MAX_CONSUMED,
  createSamlReplayStore,
};
