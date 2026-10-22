'use strict';

/**
 * The rules every outbound HTTPS delivery in HUQAN follows: which endpoints
 * are acceptable, which failures are worth another attempt, and how long a
 * server may ask us to wait.
 *
 * They began in lib/observability/notification-adapter.js. The SIEM push
 * transport (#4093, PR-B4) needs the same rules, and it sits in the Adapters
 * ring, which may not require the Application-ring adapter. Rather than grow a
 * second copy that could drift, the rules live here and both deliverers use
 * them; the notification adapter's behaviour is unchanged.
 *
 * Pure: no network, no clock, no state.
 */

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

/**
 * The endpoint's href, or a thrown error built by `makeError`.
 *
 * HTTPS only, and no credentials, query or fragment: a secret in a URL ends up
 * in every log line and proxy that sees the URL, so a deliverer takes its
 * secret from a header instead and refuses a URL that carries one.
 */
function normalizeHttpsUrl(rawUrl, makeError, label = 'Webhook URL') {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch (_) { throw makeError(`${label} must be a valid HTTPS URL.`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw makeError(`${label} must use HTTPS without credentials, query parameters or fragments.`);
  }
  return parsed.href;
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  return String(headers[name] || headers[name.toLowerCase()] || '');
}

/** A server's `Retry-After`, in milliseconds and capped, or null when it gave none. */
function retryAfterMs(response, maximum) {
  const raw = responseHeader(response, 'retry-after').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(maximum, Math.floor(seconds * 1000));
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

function isRetryableError(error) {
  return error?.name === 'AbortError'
    || error?.name === 'TypeError'
    || error?.code === 'ECONNRESET'
    || error?.code === 'ETIMEDOUT';
}

module.exports = {
  RETRYABLE_STATUS_CODES,
  isRetryableError,
  isRetryableStatus,
  normalizeHttpsUrl,
  retryAfterMs,
};
