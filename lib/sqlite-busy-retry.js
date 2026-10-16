'use strict';

const DEFAULT_BUSY_RETRY = Object.freeze({
  busyTimeoutMs: 250,
  maxAttempts: 3,
  initialBackoffMs: 5,
  backoffMultiplier: 2,
  maxBackoffMs: 40,
});

function resolveBusyRetryConfig(opts = {}) {
  const cfg = Object.assign({}, DEFAULT_BUSY_RETRY, opts || {});
  if (!Number.isInteger(cfg.maxAttempts) || cfg.maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(cfg.initialBackoffMs) || cfg.initialBackoffMs < 0) {
    throw new Error('initialBackoffMs must be a non-negative number');
  }
  if (!Number.isFinite(cfg.backoffMultiplier) || cfg.backoffMultiplier < 1) {
    throw new Error('backoffMultiplier must be >= 1');
  }
  if (!Number.isFinite(cfg.maxBackoffMs) || cfg.maxBackoffMs < cfg.initialBackoffMs) {
    throw new Error('maxBackoffMs must be >= initialBackoffMs');
  }
  if (!Number.isFinite(cfg.busyTimeoutMs) || cfg.busyTimeoutMs < 0) {
    throw new Error('busyTimeoutMs must be a non-negative number');
  }
  return cfg;
}

function isSqliteBusyError(err) {
  if (!err) return false;
  const code = err.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return msg.includes('SQLITE_BUSY')
    || msg.includes('SQLITE_LOCKED')
    || msg.includes('database is locked');
}

function syncSleep(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function runWithBusyRetry(fn, opts = {}) {
  const cfg = resolveBusyRetryConfig(opts);
  const sleep = typeof opts.sleepFn === 'function' ? opts.sleepFn : syncSleep;
  const label = typeof opts.label === 'string' ? opts.label : 'runWithBusyRetry';
  let lastErr = null;
  let backoff = cfg.initialBackoffMs;
  let attempt = 0;
  for (attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusyError(err) || attempt === cfg.maxAttempts) {
        break;
      }
      sleep(backoff);
      backoff = Math.min(Math.floor(backoff * cfg.backoffMultiplier), cfg.maxBackoffMs);
    }
  }
  if (lastErr && isSqliteBusyError(lastErr)) {
    try { lastErr.busyRetries = attempt; } catch (_) { /* read-only property guard */ }
    try { lastErr.busyLabel = label; } catch (_) { /* read-only property guard */ }
  }
  throw lastErr;
}

module.exports = {
  DEFAULT_BUSY_RETRY,
  resolveBusyRetryConfig,
  isSqliteBusyError,
  runWithBusyRetry,
  syncSleep,
};
