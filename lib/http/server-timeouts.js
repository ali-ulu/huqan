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

const DEFAULT_MAX_CONCURRENT_REQUESTS = 100;
const DEFAULT_RETRY_AFTER_MS = 1000;
const REQUEST_LIMITS = Object.freeze({
  MAX_CONCURRENT_REQUESTS: Object.freeze({ min: 1, max: 10000 }),
});
function invalidLimit(name, reason) {
  const error = new Error(`invalid request limit for ${name}: ${reason}`);
  error.code = 'HUQAN_REQUEST_LIMIT_INVALID';
  error.field = name;
  return error;
}
function boundedLimit(name, raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  const limit = REQUEST_LIMITS[name];
  if (!Number.isSafeInteger(value) || value < limit.min || value > limit.max) throw invalidLimit(name, `expected integer between ${limit.min} and ${limit.max}`);
  return value;
}
function resolveRequestLimits(readEnvironment) {
  if (typeof readEnvironment !== 'function') throw new TypeError('readEnvironment must be a function');
  return Object.freeze({ maxConcurrent: boundedLimit('MAX_CONCURRENT_REQUESTS', readEnvironment('MAX_CONCURRENT_REQUESTS'), DEFAULT_MAX_CONCURRENT_REQUESTS), retryAfterMs: DEFAULT_RETRY_AFTER_MS });
}
function createConcurrencyLimiter({ maxConcurrent = DEFAULT_MAX_CONCURRENT_REQUESTS } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('maxConcurrent must be positive integer');
  let active = 0; let rejected = 0;
  return Object.freeze({
    get active() { return active; }, get rejected() { return rejected; }, get maxConcurrent() { return maxConcurrent; },
    tryAcquire() { if (active >= maxConcurrent) { rejected += 1; return false; } active += 1; return true; },
    release() { if (active > 0) active -= 1; },
    stats() { return Object.freeze({ active, rejected, maxConcurrent }); },
  });
}

module.exports = Object.freeze({
  DEFAULT_HTTP_TIMEOUTS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_RETRY_AFTER_MS,
  resolveHttpServerTimeouts,
  resolveRequestLimits,
  createConcurrencyLimiter,
});

