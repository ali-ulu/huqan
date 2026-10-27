// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

// Login transaction store for the OIDC RP (#4267; contract in docs/sso.md).
//
// Each login start generates state, nonce and a PKCE verifier. They must be
// bound to the browser that started the login and must be single-use, so the
// RP keeps a short-lived transaction record keyed by the state value and
// consumes it at the callback.
//
// The record holds the PKCE verifier and nonce, which are protocol secrets for
// the lifetime of one login. They are never returned to a caller other than
// the callback that consumes the record, and the record is deleted the moment
// it is read, so a replayed callback finds nothing. The set is bounded and
// swept by age so a flood of login starts cannot grow memory.

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TRANSACTIONS = 5000;

function normalizeState(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function createOidcTransactionStore({ now = Date.now, ttlMs = DEFAULT_TTL_MS, maxTransactions = MAX_TRANSACTIONS, randomBytes = crypto.randomBytes } = {}) {
  const transactions = new Map();

  function sweep(timestamp) {
    for (const [state, record] of transactions) {
      if (timestamp >= record.expiresAt) transactions.delete(state);
    }
  }

  /**
   * Start a transaction. Returns the values the authorization request needs
   * and the state the RP keys the record by.
   */
  function begin() {
    const timestamp = now();
    sweep(timestamp);
    if (transactions.size >= maxTransactions) {
      let oldestState;
      let oldest = Infinity;
      for (const [state, record] of transactions) {
        if (record.createdAt < oldest) {
          oldest = record.createdAt;
          oldestState = state;
        }
      }
      if (oldestState !== undefined) transactions.delete(oldestState);
    }
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    transactions.set(state, { state, nonce, codeVerifier, createdAt: timestamp, expiresAt: timestamp + ttlMs });
    return { state, nonce, codeVerifier };
  }

  /**
   * Consume a transaction exactly once. A missing, malformed, expired or
   * already-consumed state yields null; the record is deleted either way.
   */
  function consume(state) {
    const key = normalizeState(state);
    if (!key) return null;
    const record = transactions.get(key);
    if (!record) return null;
    transactions.delete(key);
    if (now() >= record.expiresAt) return null;
    return { state: record.state, nonce: record.nonce, codeVerifier: record.codeVerifier };
  }

  return {
    begin,
    consume,
    size: () => transactions.size,
    reset: () => { transactions.clear(); },
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_TRANSACTIONS,
  createOidcTransactionStore,
};
