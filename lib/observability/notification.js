'use strict';

const crypto = require('node:crypto');

function parseWebhookPolicy(raw) {
  if (raw === undefined || raw === null || raw === '') return Object.freeze({ enabled: false });
  let input;
  try { input = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { input = null; }
  const allowed = ['enabled', 'url', 'secret', 'timeoutMs', 'maxAttempts', 'baseDelayMs'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean'
      || Object.keys(input).some(key => !allowed.includes(key))) {
    const error = new Error('Observability webhook policy is invalid.');
    error.code = 'OBSERVABILITY_WEBHOOK_POLICY_INVALID';
    throw error;
  }
  if (!input.enabled) return Object.freeze({ enabled: false });
  let url;
  try { url = new URL(input.url); } catch (_) { url = null; }
  const integer = (value, fallback, minimum, maximum) => {
    const candidate = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) throw new Error('invalid');
    return candidate;
  };
  try {
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid');
    const secret = typeof input.secret === 'string' ? input.secret : '';
    if (secret.length < 16 || secret.length > 512 || /[\x00-\x1F\x7F]/.test(secret)) throw new Error('invalid');
    return Object.freeze({
      enabled: true, url: url.href, secret,
      timeoutMs: integer(input.timeoutMs, 5_000, 100, 30_000),
      maxAttempts: integer(input.maxAttempts, 3, 1, 5),
      baseDelayMs: integer(input.baseDelayMs, 250, 0, 10_000),
    });
  } catch (_) {
    const error = new Error('Observability webhook policy is invalid.');
    error.code = 'OBSERVABILITY_WEBHOOK_POLICY_INVALID';
    throw error;
  }
}

function safeNotification(input = {}) {
  return Object.freeze({
    deliveryId: String(input.deliveryId || '').slice(0, 160),
    fingerprint: String(input.fingerprint || '').slice(0, 64),
    alertId: String(input.alertId || '').slice(0, 160),
    ruleId: String(input.ruleId || '').slice(0, 160),
    workspaceId: String(input.workspaceId || '').slice(0, 128),
    metric: String(input.metric || '').slice(0, 64),
    status: String(input.status || '').slice(0, 32),
    value: Number(input.value),
    threshold: Number(input.threshold),
    occurredAt: String(input.occurredAt || '').slice(0, 40),
  });
}

function createWebhookNotificationAdapter({ policy, fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const config = parseWebhookPolicy(policy);
  if (!config.enabled) return Object.freeze({ enabled: false, deliver: async () => ({ ok: true, skipped: true }) });
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function') throw new TypeError('webhook dependencies are required');
  const delivered = new Set();
  async function deliver(input) {
    const payload = safeNotification(input);
    if (!payload.deliveryId || !payload.alertId || !payload.workspaceId) {
      const error = new Error('Notification identity is required.');
      error.code = 'OBSERVABILITY_NOTIFICATION_INVALID';
      throw error;
    }
    if (delivered.has(payload.deliveryId)) return { ok: true, duplicate: true };
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', config.secret).update(body).digest('hex');
    let lastCode = 'OBSERVABILITY_NOTIFICATION_FAILED';
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(config.url, {
          method: 'POST', redirect: 'error', signal: controller.signal, body,
          headers: { 'Content-Type': 'application/json', 'X-HUQAN-Signature': `sha256=${signature}`, 'X-HUQAN-Delivery': payload.deliveryId },
        });
        if (response.ok) { delivered.add(payload.deliveryId); return { ok: true, attempt }; }
        lastCode = `HTTP_${response.status}`;
        if (![408, 429].includes(response.status) && response.status < 500) break;
      } catch (error) { lastCode = error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'; }
      finally { clearTimeout(timer); }
      if (attempt < config.maxAttempts) await sleep(config.baseDelayMs * (2 ** (attempt - 1)));
    }
    const error = new Error('Observability notification delivery failed.');
    error.code = 'OBSERVABILITY_NOTIFICATION_FAILED';
    error.reason = lastCode;
    throw error;
  }
  return Object.freeze({ enabled: true, deliver });
}

module.exports = { createWebhookNotificationAdapter, parseWebhookPolicy, safeNotification };
