'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createWebhookNotificationAdapter, parseWebhookPolicy } = require('./notification');

const policy = overrides => ({
  enabled: true,
  url: 'https://alerts.example.test/huqan',
  secret: 'a-strong-shared-secret',
  timeoutMs: 100,
  maxAttempts: 3,
  baseDelayMs: 10,
  ...overrides,
});

const alert = { deliveryId: 'alert-1:firing', alertId: 'alert-1', ruleId: 'rule-1', workspaceId: 'ws-a',
  fingerprint: 'abc', metric: 'queue_depth', status: 'firing', value: 2, threshold: 0,
  occurredAt: '2026-08-24T00:00:00.000Z', prompt: 'private', goal: 'private', token: 'private' };

test('webhook policy is disabled by default and rejects unsafe or ambiguous configuration', () => {
  assert.deepEqual(parseWebhookPolicy(), { enabled: false });
  for (const candidate of [
    policy({ url: 'http://alerts.example.test/huqan' }),
    policy({ secret: 'short' }),
    { ...policy(), unknown: true },
  ]) assert.throws(() => parseWebhookPolicy(candidate), { code: 'OBSERVABILITY_WEBHOOK_POLICY_INVALID' });
});

test('webhook delivery retries transient failures, signs an allowlisted payload and deduplicates success', async () => {
  const calls = [];
  const sleeps = [];
  const adapter = createWebhookNotificationAdapter({
    policy: policy(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: calls.length > 1, status: calls.length > 1 ? 204 : 500 };
    },
    sleep: async ms => sleeps.push(ms),
  });
  assert.deepEqual(await adapter.deliver(alert), { ok: true, attempt: 2 });
  assert.deepEqual(await adapter.deliver(alert), { ok: true, duplicate: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [10]);
  assert.equal(calls[0].options.redirect, 'error');
  const body = calls[0].options.body;
  assert.equal(body.includes('private'), false);
  const expected = crypto.createHmac('sha256', policy().secret).update(body).digest('hex');
  assert.equal(calls[0].options.headers['X-HUQAN-Signature'], `sha256=${expected}`);
});

test('webhook delivery stops on permanent failure and reports a generic error', async () => {
  let calls = 0;
  const adapter = createWebhookNotificationAdapter({ policy: policy(), fetchImpl: async () => {
    calls += 1;
    return { ok: false, status: 400 };
  } });
  await assert.rejects(adapter.deliver(alert), error => {
    assert.equal(error.code, 'OBSERVABILITY_NOTIFICATION_FAILED');
    assert.equal(error.message.includes(policy().secret), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('webhook timeout retries only within configured attempt bound', async () => {
  let calls = 0;
  const adapter = createWebhookNotificationAdapter({
    policy: policy({ maxAttempts: 2, baseDelayMs: 0 }),
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
      }, { once: true }));
    },
    sleep: async () => {},
  });
  await assert.rejects(adapter.deliver(alert), { code: 'OBSERVABILITY_NOTIFICATION_FAILED' });
  assert.equal(calls, 2);
});
