'use strict';

const crypto = require('node:crypto');
const { safePayload } = require('./helpers');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_MS = 250;
const MAX_ATTEMPTS = 5;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_DELIVERED_IDS = 2_048;
const NOTIFICATION_ERROR_CODES = Object.freeze([
  'NOTIFICATION_INVALID_CONFIG',
  'NOTIFICATION_INVALID_PAYLOAD',
  'NOTIFICATION_TIMEOUT',
  'NOTIFICATION_RETRY_EXHAUSTED',
  'NOTIFICATION_HTTP_REJECTED',
  'NOTIFICATION_FAILED',
]);
const ALERT_FIELDS = Object.freeze([
  'alertId',
  'ruleId',
  'workspaceId',
  'metric',
  'value',
  'threshold',
  'status',
  'fingerprint',
  'eventId',
  'firedAt',
  'resolvedAt',
]);
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

function configError(message) {
  const error = new Error(message);
  error.code = 'NOTIFICATION_INVALID_CONFIG';
  return error;
}

function payloadError(message) {
  const error = new Error(message);
  error.code = 'NOTIFICATION_INVALID_PAYLOAD';
  return error;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}

function normalizeHttpsUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch (_) { throw configError('Webhook URL must be a valid HTTPS URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw configError('Webhook URL must use HTTPS without credentials, query parameters or fragments.');
  }
  return parsed.href;
}

function normalizeSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 512) {
    throw configError('Webhook secret must be 16 to 512 characters.');
  }
  return secret;
}

function normalizeId(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 128 || /[\x00-\x1F\x7F]/.test(normalized)) {
    throw payloadError(`${field} is required and must be bounded.`);
  }
  return normalized;
}

function normalizeOptionalString(value, field, maximum = 160) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1F\x7F]/.test(value)) {
    throw payloadError(`${field} is invalid.`);
  }
  return value;
}

function safeAlert(alert) {
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) return null;
  const output = {};
  for (const field of ALERT_FIELDS) {
    if (alert[field] === undefined) continue;
    if (['value', 'threshold'].includes(field)) {
      if (!Number.isFinite(Number(alert[field]))) throw payloadError(`${field} is invalid.`);
      output[field] = Number(alert[field]);
      continue;
    }
    output[field] = normalizeOptionalString(alert[field], field, field === 'fingerprint' ? 128 : 160);
  }
  return output;
}

function normalizeNotification(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw payloadError('Notification payload must be an object.');
  const notificationId = normalizeId(input.notificationId, 'notificationId');
  const type = normalizeId(input.type, 'type');
  const workspaceId = normalizeId(input.workspaceId, 'workspaceId');
  const output = { notificationId, type, workspaceId };
  const alert = safeAlert(input.alert);
  if (alert) output.alert = alert;
  const metadata = safePayload(input.metadata);
  if (Object.keys(metadata).length) output.metadata = metadata;
  return output;
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(stableJson(item))));
  if (value && typeof value === 'object') {
    const ordered = {};
    for (const key of Object.keys(value).sort()) ordered[key] = JSON.parse(stableJson(value[key]));
    return JSON.stringify(ordered);
  }
  return JSON.stringify(value);
}

function signatureFor(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  return String(headers[name] || headers[name.toLowerCase()] || '');
}

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

function failureResult(code, attempts, notificationId, status = null) {
  return { ok: false, code, attempts, notificationId, ...(status === null ? {} : { status }) };
}

function createNotificationAdapter({ name, deliver } = {}) {
  if (!name || typeof name !== 'string' || typeof deliver !== 'function') throw new TypeError('notification adapter name and deliver function are required');
  return Object.freeze({ name, deliver });
}

function createWebhookNotificationAdapter({
  url,
  secret,
  fetchImpl = globalThis.fetch,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxDeliveredIds = MAX_DELIVERED_IDS,
} = {}) {
  const endpoint = normalizeHttpsUrl(url);
  const signingSecret = normalizeSecret(secret);
  if (typeof fetchImpl !== 'function') throw configError('Webhook fetch implementation is required.');
  if (typeof sleep !== 'function') throw configError('Webhook sleep implementation is required.');
  const attemptsLimit = boundedInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS);
  const timeout = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
  const backoff = boundedInteger(backoffMs, DEFAULT_BACKOFF_MS, 0, MAX_BACKOFF_MS);
  const deliveredLimit = boundedInteger(maxDeliveredIds, MAX_DELIVERED_IDS, 1, MAX_DELIVERED_IDS);
  const delivered = new Map();

  function rememberDelivered(notificationId) {
    delivered.delete(notificationId);
    delivered.set(notificationId, true);
    while (delivered.size > deliveredLimit) delivered.delete(delivered.keys().next().value);
  }

  async function deliver(input) {
    let notification;
    try { notification = normalizeNotification(input); } catch (error) {
      return failureResult(error.code || 'NOTIFICATION_INVALID_PAYLOAD', 0, String(input?.notificationId || ''));
    }
    if (delivered.has(notification.notificationId)) {
      return { ok: true, duplicate: true, delivered: false, attempts: 0, notificationId: notification.notificationId };
    }

    const body = stableJson(notification);
    const signature = signatureFor(signingSecret, body);
    let lastStatus = null;
    for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'HUQAN-Observability-Webhook/1',
            'X-Huqan-Notification-Id': notification.notificationId,
            'X-Huqan-Notification-Signature': signature,
          },
          body,
          signal: controller.signal,
        });
        lastStatus = Number(response?.status || 0);
        if (lastStatus >= 200 && lastStatus < 300) {
          rememberDelivered(notification.notificationId);
          return { ok: true, duplicate: false, delivered: true, attempts: attempt, notificationId: notification.notificationId, status: lastStatus };
        }
        if (!isRetryableStatus(lastStatus) || attempt === attemptsLimit) {
          return failureResult(isRetryableStatus(lastStatus) ? 'NOTIFICATION_RETRY_EXHAUSTED' : 'NOTIFICATION_HTTP_REJECTED', attempt, notification.notificationId, lastStatus);
        }
        const retryDelay = retryAfterMs(response, backoff * 16) ?? Math.min(backoff * (2 ** (attempt - 1)), backoff * 16);
        await sleep(retryDelay);
      } catch (error) {
        if (attempt === attemptsLimit || !isRetryableError(error)) {
          return failureResult(error?.name === 'AbortError' ? 'NOTIFICATION_TIMEOUT' : 'NOTIFICATION_FAILED', attempt, notification.notificationId, lastStatus);
        }
        await sleep(Math.min(backoff * (2 ** (attempt - 1)), backoff * 16));
      } finally {
        clearTimeout(timer);
      }
    }
    return failureResult('NOTIFICATION_RETRY_EXHAUSTED', attemptsLimit, notification.notificationId, lastStatus);
  }

  return createNotificationAdapter({ name: 'https-webhook', deliver });
}

async function notifySafely(adapter, input) {
  try {
    if (!adapter || typeof adapter.deliver !== 'function') return failureResult('NOTIFICATION_FAILED', 0, String(input?.notificationId || ''));
    return await adapter.deliver(input);
  } catch (_) {
    return failureResult('NOTIFICATION_FAILED', 0, String(input?.notificationId || ''));
  }
}

module.exports = {
  ALERT_FIELDS,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_DELIVERED_IDS,
  MAX_TIMEOUT_MS,
  NOTIFICATION_ERROR_CODES,
  RETRYABLE_STATUS_CODES,
  createNotificationAdapter,
  createWebhookNotificationAdapter,
  isRetryableError,
  isRetryableStatus,
  normalizeNotification,
  notifySafely,
  signatureFor,
};
