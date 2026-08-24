'use strict';

const DEFAULT_POLICY = Object.freeze({
  windowMs: 60_000,
  listRequests: 120,
  queueMutations: 30,
  alertMutations: 30,
  streamAttempts: 20,
  streamConnections: 3,
  maxEntries: 10_000,
});

function positiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    const error = new Error('Observability rate-limit policy is invalid.');
    error.code = 'OBSERVABILITY_RATE_LIMIT_POLICY_INVALID';
    throw error;
  }
  return value;
}

function parseRateLimitPolicy(raw) {
  let input = {};
  if (raw !== undefined && raw !== null && raw !== '') {
    try { input = JSON.parse(String(raw)); } catch (_) { input = null; }
  }
  const keys = Object.keys(DEFAULT_POLICY);
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !keys.includes(key))) {
    const error = new Error('Observability rate-limit policy is invalid.');
    error.code = 'OBSERVABILITY_RATE_LIMIT_POLICY_INVALID';
    throw error;
  }
  return Object.freeze({
    windowMs: positiveInteger(input.windowMs, DEFAULT_POLICY.windowMs, 3_600_000),
    listRequests: positiveInteger(input.listRequests, DEFAULT_POLICY.listRequests, 100_000),
    queueMutations: positiveInteger(input.queueMutations, DEFAULT_POLICY.queueMutations, 100_000),
    alertMutations: positiveInteger(input.alertMutations, DEFAULT_POLICY.alertMutations, 100_000),
    streamAttempts: positiveInteger(input.streamAttempts, DEFAULT_POLICY.streamAttempts, 100_000),
    streamConnections: positiveInteger(input.streamConnections, DEFAULT_POLICY.streamConnections, 10_000),
    maxEntries: positiveInteger(input.maxEntries, DEFAULT_POLICY.maxEntries, 1_000_000),
  });
}

function createObservabilityRateLimiter({ policy, now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('rate-limit clock must be a function');
  const config = parseRateLimitPolicy(policy);
  const buckets = new Map();
  const streams = new Map();

  function identity(input) {
    const subject = typeof input?.principal?.subject === 'string' ? input.principal.subject.trim() : '';
    const workspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId.trim() : '';
    return subject && workspaceId ? `${subject}\0${workspaceId}` : '';
  }

  function clean(timestamp) {
    for (const [key, bucket] of buckets) if (timestamp >= bucket.resetAt) buckets.delete(key);
  }

  function check(input = {}) {
    const id = identity(input);
    const maximum = config[input.action];
    if (!id || !Number.isSafeInteger(maximum)) {
      return Object.freeze({ allowed: false, code: 'OBSERVABILITY_RATE_LIMIT_IDENTITY_INVALID', retryAfter: 1 });
    }
    const timestamp = now();
    clean(timestamp);
    const key = `${id}\0${input.action}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= config.maxEntries) {
        return Object.freeze({ allowed: false, code: 'OBSERVABILITY_RATE_LIMITED', retryAfter: 1 });
      }
      bucket = { count: 0, resetAt: timestamp + config.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000));
    return Object.freeze({
      allowed: bucket.count <= maximum,
      code: bucket.count <= maximum ? 'OBSERVABILITY_RATE_LIMIT_OK' : 'OBSERVABILITY_RATE_LIMITED',
      retryAfter,
    });
  }

  function acquireStream(input = {}) {
    const id = identity(input);
    if (!id) return Object.freeze({ allowed: false, code: 'OBSERVABILITY_RATE_LIMIT_IDENTITY_INVALID', retryAfter: 1 });
    const active = streams.get(id) || 0;
    if (active >= config.streamConnections) {
      return Object.freeze({ allowed: false, code: 'OBSERVABILITY_STREAM_LIMITED', retryAfter: 1 });
    }
    streams.set(id, active + 1);
    let released = false;
    return Object.freeze({
      allowed: true,
      code: 'OBSERVABILITY_RATE_LIMIT_OK',
      release() {
        if (released) return;
        released = true;
        const remaining = (streams.get(id) || 1) - 1;
        if (remaining > 0) streams.set(id, remaining); else streams.delete(id);
      },
    });
  }

  return Object.freeze({ check, acquireStream, policy: config });
}

module.exports = { DEFAULT_POLICY, createObservabilityRateLimiter, parseRateLimitPolicy };
