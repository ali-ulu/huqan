'use strict';

// Mounted from server.js by #2128. The viewer UI (session store + gateway)
// plus its per-IP rate limiter move here verbatim so the composition root
// keeps wiring only. No kernel decisions live here: the gateway receives its
// readReceipt callback, the limiter is a self-contained token bucket.

const { createSessionStore } = require('../viewer/session-store');
const { createViewerGateway } = require('../viewer/viewer-gateway');

const VIEWER_RATE_LIMIT_WINDOW_MS = 60_000;
const VIEWER_RATE_LIMIT_MAX = 120;
const VIEWER_RATE_LIMIT_MAX_ENTRIES = 2048;

function createViewerRateLimiter({
  windowMs = VIEWER_RATE_LIMIT_WINDOW_MS,
  max = VIEWER_RATE_LIMIT_MAX,
  maxEntries = VIEWER_RATE_LIMIT_MAX_ENTRIES,
} = {}) {
  const records = new Map();

  function check(req, timestamp = Date.now()) {
    const key = String(req.socket?.remoteAddress || 'unknown');
    let record = records.get(key);
    if (record && timestamp >= record.resetAt) {
      records.delete(key);
      record = null;
    }
    if (!record) {
      if (records.size >= maxEntries) {
        for (const [candidate, entry] of records) {
          if (timestamp >= entry.resetAt) records.delete(candidate);
        }
      }
      if (records.size >= maxEntries) return false;
      record = { count: 0, resetAt: timestamp + windowMs };
      records.set(key, record);
    }
    record.count += 1;
    return record.count <= max;
  }

  function reset() {
    records.clear();
  }

  return { check, reset };
}

/**
 * @param {object} deps - { readReceipt } (kernel.graph reader, supplied by the root)
 */
function createViewerMount({ readReceipt } = {}) {
  const sessionStore = createSessionStore();
  const gateway = createViewerGateway({ sessionStore, readReceipt });
  const limiter = createViewerRateLimiter();

  return {
    isViewerPath: (rawPath) => gateway.isViewerPath(rawPath),
    checkRateLimit: (req, timestamp) => limiter.check(req, timestamp),
    handle: (req, res, reqUrl) => gateway.handle(req, res, reqUrl),
    reset: () => {
      limiter.reset();
      sessionStore.reset();
    },
  };
}

module.exports = {
  createViewerMount,
  createViewerRateLimiter,
  VIEWER_RATE_LIMIT_WINDOW_MS,
  VIEWER_RATE_LIMIT_MAX,
  VIEWER_RATE_LIMIT_MAX_ENTRIES,
};
