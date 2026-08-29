'use strict';

const DEFAULT_HTTP_TIMEOUTS = Object.freeze({
  headersTimeout: 10_000,
  requestTimeout: 30_000,
  keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 1_000,
});

const LIMITS = Object.freeze({
  HEADERS_TIMEOUT_MS: Object.freeze({ min: 1_000, max: 120_000 }),
  REQUEST_TIMEOUT_MS: Object.freeze({ min: 1_000, max: 300_000 }),
  KEEP_ALIVE_TIMEOUT_MS: Object.freeze({ min: 100, max: 60_000 }),
});

function invalidTimeout(name, reason) {
  const error = new Error(`invalid HTTP timeout configuration for ${name}: ${reason}`);
  error.code = 'HUQAN_HTTP_TIMEOUT_INVALID';
  error.field = name;
  return error;
}

function boundedInteger(name, raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  const limit = LIMITS[name];
  if (!Number.isSafeInteger(value) || value < limit.min || value > limit.max) {
    throw invalidTimeout(name, `expected an integer between ${limit.min} and ${limit.max} milliseconds`);
  }
  return value;
}

function resolveHttpServerTimeouts(readEnvironment) {
  if (typeof readEnvironment !== 'function') throw new TypeError('readEnvironment must be a function');
  const headersTimeout = boundedInteger('HEADERS_TIMEOUT_MS', readEnvironment('HEADERS_TIMEOUT_MS'), DEFAULT_HTTP_TIMEOUTS.headersTimeout);
  const requestTimeout = boundedInteger('REQUEST_TIMEOUT_MS', readEnvironment('REQUEST_TIMEOUT_MS'), DEFAULT_HTTP_TIMEOUTS.requestTimeout);
  const keepAliveTimeout = boundedInteger('KEEP_ALIVE_TIMEOUT_MS', readEnvironment('KEEP_ALIVE_TIMEOUT_MS'), DEFAULT_HTTP_TIMEOUTS.keepAliveTimeout);
  if (headersTimeout > requestTimeout) {
    throw invalidTimeout('HEADERS_TIMEOUT_MS', 'must not exceed REQUEST_TIMEOUT_MS');
  }
  return Object.freeze({
    headersTimeout,
    requestTimeout,
    keepAliveTimeout,
    connectionsCheckingInterval: Math.min(DEFAULT_HTTP_TIMEOUTS.connectionsCheckingInterval, headersTimeout),
  });
}

module.exports = Object.freeze({
  DEFAULT_HTTP_TIMEOUTS,
  resolveHttpServerTimeouts,
});

