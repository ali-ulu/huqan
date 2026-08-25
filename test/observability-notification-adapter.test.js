'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_BACKOFF_MS,
  NOTIFICATION_ERROR_CODES,
  createWebhookNotificationAdapter,
  normalizeNotification,
  notifySafely,
  signatureFor,
} = require('../lib/observability/notification-adapter');

const SECRET = 'notification-test-secret-012345';
const BASE_INPUT = {
  notificationId: 'notification-1',
  type: 'observability.alert',
  workspaceId: 'workspace-a',
  alert: {
    alertId: 'alert-1',
    ruleId: 'rule-1',
    metric: 'error_count',
    value: 4,
    threshold: 2,
    status: 'firing',
    fingerprint: 'a'.repeat(64),
    eventId: 'event-1',
    firedAt: '2026-08-25T20:00:00.000Z',
    resolvedAt: null,
    goal: 'must not escape',
  },
  metadata: {
    source: 'alert-lifecycle',
    secret: SECRET,
    prompt: 'must not escape',
    count: 1,
  },
};

function response(status, headers = {}) {
  return { status, headers: { get: name => headers[name.toLowerCase()] || '' } };
}

test('normalizes only bounded alert notification fields and drops plaintext secrets', () => {
  const normalized = normalizeNotification(BASE_INPUT);
  assert.deepEqual(normalized, {
    notificationId: 'notification-1',
    type: 'observability.alert',
    workspaceId: 'workspace-a',
    alert: {
      alertId: 'alert-1',
      ruleId: 'rule-1',
      metric: 'error_count',
      value: 4,
      threshold: 2,
      status: 'firing',
      fingerprint: 'a'.repeat(64),
      eventId: 'event-1',
      firedAt: '2026-08-25T20:00:00.000Z',
      resolvedAt: null,
    },
    metadata: { source: 'alert-lifecycle', count: 1 },
  });
  assert.equal(JSON.stringify(normalized).includes(SECRET), false);
  assert.equal(JSON.stringify(normalized).includes('must not escape'), false);
});

test('rejects non-HTTPS webhook configuration without exposing a secret', () => {
  for (const url of ['http://example.test/hook', 'https://user:pass@example.test/hook', 'https://example.test/hook?x=1', 'https://example.test/hook#fragment']) {
    assert.throws(() => createWebhookNotificationAdapter({ url, secret: SECRET, fetchImpl: async () => response(204) }), error => error.code === 'NOTIFICATION_INVALID_CONFIG');
  }
  assert.throws(() => createWebhookNotificationAdapter({ url: 'https://example.test/hook', secret: 'short', fetchImpl: async () => response(204) }), error => {
    assert.equal(error.code, 'NOTIFICATION_INVALID_CONFIG');
    assert.equal(error.message.includes('short'), false);
    return true;
  });
});

test('posts deterministic signed JSON and accepts only 2xx responses', async () => {
  const calls = [];
  const adapter = createWebhookNotificationAdapter({
    url: 'https://example.test/hook',
    secret: SECRET,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(204);
    },
  });
  const result = await adapter.deliver(BASE_INPUT);
  assert.deepEqual(result, { ok: true, duplicate: false, delivered: true, attempts: 1, notificationId: 'notification-1', status: 204 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/hook');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['X-Huqan-Notification-Id'], 'notification-1');
  assert.equal(calls[0].options.headers['X-Huqan-Notification-Signature'], signatureFor(SECRET, calls[0].options.body));
  assert.equal(calls[0].options.body.includes(SECRET), false);
  assert.equal(calls[0].options.body.includes('goal'), false);
});

test('retries transient HTTP responses with bounded exponential backoff and honors Retry-After', async () => {
  const statuses = [response(503), response(429, { 'retry-after': '2' }), response(204)];
  const delays = [];
  let calls = 0;
  const adapter = createWebhookNotificationAdapter({
    url: 'https://example.test/hook',
    secret: SECRET,
    maxAttempts: 5,
    backoffMs: DEFAULT_BACKOFF_MS,
    fetchImpl: async () => statuses[calls++],
    sleep: async delay => delays.push(delay),
  });
  const result = await adapter.deliver(BASE_INPUT);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [250, 2000]);
  assert.equal(calls, 3);
});

test('does not retry non-transient HTTP rejection and caps retry exhaustion', async () => {
  let rejectedCalls = 0;
  const rejected = createWebhookNotificationAdapter({
    url: 'https://example.test/hook',
    secret: SECRET,
    fetchImpl: async () => { rejectedCalls += 1; return response(400); },
    sleep: async () => { throw new Error('sleep must not run'); },
  });
  assert.deepEqual(await rejected.deliver(BASE_INPUT), { ok: false, code: 'NOTIFICATION_HTTP_REJECTED', attempts: 1, notificationId: 'notification-1', status: 400 });
  assert.equal(rejectedCalls, 1);

  let exhaustedCalls = 0;
  const exhausted = createWebhookNotificationAdapter({
    url: 'https://example.test/hook',
    secret: SECRET,
    maxAttempts: 2,
    fetchImpl: async () => { exhaustedCalls += 1; return response(503); },
    sleep: async () => {},
  });
  const result = await exhausted.deliver(BASE_INPUT);
  assert.deepEqual(result, { ok: false, code: 'NOTIFICATION_RETRY_EXHAUSTED', attempts: 2, notificationId: 'notification-1', status: 503 });
  assert.equal(exhaustedCalls, 2);
});

test('returns a typed timeout result and never exceeds the attempt bound', async () => {
  let calls = 0;
  const adapter = createWebhookNotificationAdapter({
    url: 'https://example.test/hook',
    secret: SECRET,
    maxAttempts: 2,
    timeoutMs: 100,
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
        const error = new Error('timed out');
        error.name = 'AbortError';
        reject(error);
      }));
    },
    sleep: async () => {},
  });
  const result = await adapter.deliver(BASE_INPUT);
  assert.deepEqual(result, { ok: false, code: 'NOTIFICATION_TIMEOUT', attempts: 2, notificationId: 'notification-1' });
  assert.equal(calls, 2);
});

test('suppresses sequential duplicate delivery with bounded in-memory state', async () => {
  let calls = 0;
  const adapter = createWebhookNotificationAdapter({
    url: 'https://example.test/hook',
    secret: SECRET,
    fetchImpl: async () => { calls += 1; return response(200); },
  });
  const first = await adapter.deliver(BASE_INPUT);
  const second = await adapter.deliver({ ...BASE_INPUT, metadata: { source: 'different' } });
  assert.equal(first.delivered, true);
  assert.deepEqual(second, { ok: true, duplicate: true, delivered: false, attempts: 0, notificationId: 'notification-1' });
  assert.equal(calls, 1);
});

test('notifySafely converts adapter exceptions to a non-throwing typed failure', async () => {
  const result = await notifySafely({ deliver: async () => { throw new Error(`secret=${SECRET}`); } }, BASE_INPUT);
  assert.deepEqual(result, { ok: false, code: 'NOTIFICATION_FAILED', attempts: 0, notificationId: 'notification-1' });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(NOTIFICATION_ERROR_CODES, [
    'NOTIFICATION_INVALID_CONFIG',
    'NOTIFICATION_INVALID_PAYLOAD',
    'NOTIFICATION_TIMEOUT',
    'NOTIFICATION_RETRY_EXHAUSTED',
    'NOTIFICATION_HTTP_REJECTED',
    'NOTIFICATION_FAILED',
  ]);
});

test('runbook states that delivery is not automatically wired to an external endpoint', () => {
  const runbook = fs.readFileSync(path.join(__dirname, '..', 'docs', 'observability-notifications.md'), 'utf8');
  assert.match(runbook, /otomatik.*istek göndermez/);
  assert.match(runbook, /external notification delivery/);
});
