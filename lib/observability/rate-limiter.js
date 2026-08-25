'use strict';

const WINDOW_MS = 60_000;
const MAX_ENTRIES = 4_096;

const DEFAULT_POLICIES = Object.freeze({
  read: Object.freeze({ limit: 120, windowMs: WINDOW_MS }),
  stream: Object.freeze({ limit: 12, windowMs: WINDOW_MS, maxConcurrent: 2 }),
  queue: Object.freeze({ limit: 30, windowMs: WINDOW_MS }),
  alerts: Object.freeze({ limit: 30, windowMs: WINDOW_MS }),
});

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function normalizePolicy(policy, fallback) {
  const source = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
  return Object.freeze({
    limit: positiveInteger(source.limit, fallback.limit, 10_000),
    windowMs: positiveInteger(source.windowMs, fallback.windowMs, 24 * 60 * 60 * 1000),
    ...(fallback.maxConcurrent === undefined && source.maxConcurrent === undefined
      ? {}
      : { maxConcurrent: positiveInteger(source.maxConcurrent, fallback.maxConcurrent || 1, 1_000) }),
  });
}

function createObservabilityRateLimiter({ now = Date.now, policies = DEFAULT_POLICIES, maxEntries = MAX_ENTRIES } = {}) {
  if (typeof now !== 'function') throw new TypeError('rate limiter clock must be a function');
  const configuredPolicies = Object.fromEntries(Object.entries(DEFAULT_POLICIES).map(([name, fallback]) => [
    name,
    normalizePolicy(policies?.[name], fallback),
  ]));
  const entryLimit = positiveInteger(maxEntries, MAX_ENTRIES, 100_000);
  const entries = new Map();

  function entryKey(bucket, key) {
    return `${bucket}\0${String(key)}`;
  }

  function pruneEntry(entry, timestamp, policy) {
    const cutoff = timestamp - policy.windowMs;
    let firstLive = 0;
    while (firstLive < entry.timestamps.length && entry.timestamps[firstLive] <= cutoff) firstLive += 1;
    if (firstLive > 0) entry.timestamps.splice(0, firstLive);
    entry.lastUsed = timestamp;
  }

  function evictInactive(timestamp) {
    for (const [key, entry] of entries) {
      const policy = configuredPolicies[entry.bucket];
      pruneEntry(entry, timestamp, policy);
      if (entry.active === 0 && entry.timestamps.length === 0) entries.delete(key);
    }
    if (entries.size < entryLimit) return true;
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of entries) {
      if (entry.active === 0 && entry.lastUsed < oldestAt) {
        oldestKey = key;
        oldestAt = entry.lastUsed;
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey);
    return entries.size < entryLimit;
  }

  function getEntry(bucket, key, timestamp) {
    const id = entryKey(bucket, key);
    let entry = entries.get(id);
    if (entry) {
      pruneEntry(entry, timestamp, configuredPolicies[bucket]);
      return { id, entry };
    }
    if (!evictInactive(timestamp)) return { id, entry: null };
    entry = { bucket, timestamps: [], active: 0, lastUsed: timestamp };
    entries.set(id, entry);
    return { id, entry };
  }

  function limited(policy, entry, timestamp, reason) {
    const oldest = entry?.timestamps[0];
    const rateRetryMs = oldest === undefined ? policy.windowMs : Math.max(0, oldest + policy.windowMs - timestamp);
    const retryAfterMs = reason === 'concurrency' ? policy.windowMs : rateRetryMs;
    return {
      allowed: false,
      reason,
      limit: policy.limit,
      remaining: 0,
      resetAt: timestamp + retryAfterMs,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      release() {},
    };
  }

  function acquire({ bucket, key } = {}) {
    const policy = configuredPolicies[bucket];
    if (!policy) throw new TypeError(`unknown observability rate-limit bucket: ${bucket}`);
    const timestamp = Number(now());
    const current = Number.isFinite(timestamp) ? timestamp : Date.now();
    const { id, entry } = getEntry(bucket, key, current);
    if (!entry) return limited(policy, { timestamps: [] }, current, 'state_exhausted');
    if (policy.maxConcurrent !== undefined && entry.active >= policy.maxConcurrent) {
      return limited(policy, entry, current, 'concurrency');
    }
    if (entry.timestamps.length >= policy.limit) return limited(policy, entry, current, 'rate');

    entry.timestamps.push(current);
    if (policy.maxConcurrent !== undefined) entry.active += 1;
    let released = false;
    function release({ refund = false } = {}) {
      if (released) return;
      released = true;
      if (policy.maxConcurrent !== undefined) entry.active = Math.max(0, entry.active - 1);
      if (refund) {
        const timestampIndex = entry.timestamps.lastIndexOf(current);
        if (timestampIndex >= 0) entry.timestamps.splice(timestampIndex, 1);
      }
      entry.lastUsed = current;
      if (entry.active === 0 && entry.timestamps.length === 0) entries.delete(id);
    }
    return {
      allowed: true,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - entry.timestamps.length),
      resetAt: current + policy.windowMs,
      retryAfterSeconds: 0,
      release,
      cancel: () => release({ refund: true }),
    };
  }

  function stateSize() {
    return entries.size;
  }

  return Object.freeze({ acquire, stateSize });
}

module.exports = {
  DEFAULT_POLICIES,
  MAX_ENTRIES,
  WINDOW_MS,
  createObservabilityRateLimiter,
};
