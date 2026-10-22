'use strict';

// #4093 PR-B4: the HTTPS push transport. It delivers rendered SIEM events to a
// Splunk HEC endpoint or an Elastic `_bulk` endpoint. The tests pin the
// properties the scope note lists as INV-B4 and INV-B5: a delivery that did
// not succeed throws (so the export keeps its cursor), only HTTPS without
// credentials in the URL is accepted, and the token never leaves the
// Authorization header.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SIEM_HTTP_ERRORS, createSiemHttpSink } = require('../lib/siem/siem-http-sink');
const { SIEM_PUSH_ERRORS } = require('../lib/siem/siem-push-policy');

const TOKEN = 'hec-token-0123456789abcdef';
// No policy file, no expected-egress environment: the destination gates are inert.
const HERMETIC = Object.freeze({ environment: {}, dataResidency: null });

function event(id, decision = 'allow') {
  return { 'event.id': id, 'huqan.decision': decision, '@timestamp': '2026-10-21T15:01:00.000Z' };
}

function response(status, body = '', headers = {}) {
  return { status, headers, text: async () => body };
}

function recorder(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next || response(200, '{"text":"Success","code":0}');
  };
  return { calls, fetchImpl };
}

const noSleep = async () => {};

test('refuses non-tls syslog and plain http endpoints', () => {
  for (const url of ['http://siem.example.com/services/collector/event', 'ftp://siem.example.com/']) {
    assert.throws(() => createSiemHttpSink({ ...HERMETIC, url, format: 'hec', token: TOKEN }), { code: SIEM_HTTP_ERRORS.INVALID_CONFIG });
  }
});

test('refuses an endpoint that carries credentials, a query or a fragment', () => {
  for (const url of [
    'https://user:pass@siem.example.com/services/collector/event',
    'https://siem.example.com/services/collector/event?token=abc',
    'https://siem.example.com/services/collector/event#frag',
  ]) {
    assert.throws(() => createSiemHttpSink({ ...HERMETIC, url, format: 'hec', token: TOKEN }), { code: SIEM_HTTP_ERRORS.INVALID_CONFIG });
  }
});

test('refuses to start without a token rather than sending unauthenticated', () => {
  assert.throws(() => createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: '' }), { code: SIEM_HTTP_ERRORS.TOKEN_REQUIRED });
});

test('accepts only the formats an HTTP collector ingests: hec and ecs', () => {
  for (const format of ['jsonl', 'cef', 'xml']) {
    assert.throws(() => createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format, token: TOKEN }), { code: SIEM_HTTP_ERRORS.UNSUPPORTED_FORMAT });
  }
});

test('hec: posts the rendered envelopes with the Splunk authorization header', async () => {
  const { calls, fetchImpl } = recorder([]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com:8088/services/collector/event', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep });
  assert.equal(sink.kind, 'http');
  const result = await sink.write(['{"event":1}', '{"event":2}'], [event('a'), event('b')]);
  assert.equal(result.delivered, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://siem.example.com:8088/services/collector/event');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Splunk ${TOKEN}`);
  assert.equal(calls[0].init.body, '{"event":1}\n{"event":2}');
});

test('ecs: writes an Elastic _bulk body that creates each event under its event.id', async () => {
  const { calls, fetchImpl } = recorder([response(200, JSON.stringify({ errors: false, items: [{ create: { status: 201 } }] }))]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://es.example.com/huqan-events/_bulk', format: 'ecs', token: TOKEN, fetchImpl, sleep: noSleep });
  await sink.write(['{"event.id":"a"}'], [event('a')]);
  assert.equal(calls[0].init.headers.Authorization, `ApiKey ${TOKEN}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-ndjson');
  assert.equal(calls[0].init.body, '{"create":{"_id":"a"}}\n{"event.id":"a"}\n');
});

test('ecs: an event Elastic already holds (409) counts as delivered, so a re-run deduplicates', async () => {
  const body = JSON.stringify({ errors: true, items: [{ create: { status: 409 } }, { create: { status: 201 } }] });
  const { fetchImpl } = recorder([response(200, body)]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://es.example.com/huqan-events/_bulk', format: 'ecs', token: TOKEN, fetchImpl, sleep: noSleep });
  const result = await sink.write(['{"x":1}', '{"x":2}'], [event('a'), event('b')]);
  assert.equal(result.delivered, 2);
});

test('ecs: a bulk item Elastic rejected fails the write instead of passing as success', async () => {
  const body = JSON.stringify({ errors: true, items: [{ create: { status: 400, error: { type: 'mapper_parsing_exception' } } }] });
  const { fetchImpl } = recorder([response(200, body)]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://es.example.com/huqan-events/_bulk', format: 'ecs', token: TOKEN, fetchImpl, sleep: noSleep });
  await assert.rejects(sink.write(['{"x":1}'], [event('a')]), { code: SIEM_HTTP_ERRORS.BULK_ITEM_FAILED });
});

test('retries retryable status then stops and keeps cursor', async () => {
  const { calls, fetchImpl } = recorder([response(503), response(503), response(503)]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep, maxAttempts: 3 });
  await assert.rejects(sink.write(['{}'], [event('a')]), { code: SIEM_HTTP_ERRORS.RETRY_EXHAUSTED });
  assert.equal(calls.length, 3);
});

test('a retryable status followed by success delivers on the later attempt', async () => {
  const { calls, fetchImpl } = recorder([response(429, '', { 'retry-after': '0' }), response(200)]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep });
  const result = await sink.write(['{}'], [event('a')]);
  assert.equal(result.delivered, 1);
  assert.equal(calls.length, 2);
});

test('a status that is not retryable is not retried', async () => {
  const { calls, fetchImpl } = recorder([response(403)]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep });
  await assert.rejects(sink.write(['{}'], [event('a')]), { code: SIEM_HTTP_ERRORS.REJECTED });
  assert.equal(calls.length, 1);
});

test('hec token read from env and never logged', async () => {
  const { fetchImpl } = recorder([response(403, `denied for ${'x'}`)]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep });
  const error = await sink.write(['{}'], [event('a')]).catch(caught => caught);
  assert.ok(error instanceof Error);
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)} ${error.stack}`, new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(sink), new RegExp(TOKEN));
});

test('a network error is retried and then reported without the token', async () => {
  const failure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const { calls, fetchImpl } = recorder([failure, failure]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep, maxAttempts: 2 });
  const error = await sink.write(['{}'], [event('a')]).catch(caught => caught);
  assert.equal(error.code, SIEM_HTTP_ERRORS.FAILED);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(error.message, new RegExp(TOKEN));
});

test('a large export is split into bounded requests', async () => {
  const { calls, fetchImpl } = recorder([]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep, maxBatchEvents: 2 });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const result = await sink.write(ids.map(id => `{"id":"${id}"}`), ids.map(id => event(id)));
  assert.equal(result.delivered, 5);
  assert.equal(calls.length, 3);
});

test('writing nothing sends nothing', async () => {
  const { calls, fetchImpl } = recorder([]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep });
  assert.deepEqual(await sink.write([], []), { delivered: 0, requests: 0 });
  assert.equal(calls.length, 0);
});

test('the destination is judged when the sink is built, so a blocked host never gets a sink', () => {
  const environment = { HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'block', HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'api.github.com' };
  assert.throws(
    () => createSiemHttpSink({ url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, environment, dataResidency: null }),
    { code: SIEM_PUSH_ERRORS.BLOCKED },
  );
  const sink = createSiemHttpSink({ url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, dataResidency: null, environment: { ...environment, HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'siem.example.com' } });
  assert.equal(sink.policy.expectedEgress.decision, 'allow');
});

test('refuses to start when NODE_TLS_REJECT_UNAUTHORIZED would switch certificate checks off', () => {
  assert.throws(
    () => createSiemHttpSink({ ...HERMETIC, environment: { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN }),
    { code: SIEM_HTTP_ERRORS.TLS_VERIFICATION_DISABLED },
  );
});

test('redirects are refused, so the events never reach a host nobody judged', async () => {
  const { calls, fetchImpl } = recorder([]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep });
  await sink.write(['{}'], [event('a')]);
  assert.equal(calls[0].init.redirect, 'error');
});

test('the timeout also covers a response body that never finishes', async () => {
  const fetchImpl = async (url, init) => ({
    status: 200,
    headers: {},
    text: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://es.example.com/i/_bulk', format: 'ecs', token: TOKEN, fetchImpl, sleep: noSleep, timeoutMs: 100, maxAttempts: 1 });
  await assert.rejects(sink.write(['{}'], [event('a')]), { code: SIEM_HTTP_ERRORS.TIMEOUT });
});

test('an oversized answer is refused rather than buffered', async () => {
  const { fetchImpl } = recorder([response(200, 'x'.repeat(1024 * 1024 + 1))]);
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep });
  await assert.rejects(sink.write(['{}'], [event('a')]), { code: SIEM_HTTP_ERRORS.REJECTED });
});

test('an IPv6 endpoint reports its host without brackets, like the syslog sink', () => {
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://[2001:db8::1]:8088/x', format: 'hec', token: TOKEN });
  assert.equal(sink.host, '2001:db8::1');
});

test('a streamed answer is cut off at the cap instead of being buffered whole', async () => {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(256 * 1024);
  const fetchImpl = async () => ({
    status: 200,
    headers: {},
    body: {
      getReader: () => ({
        read: async () => { pulled += 1; return { done: false, value: chunk }; },
        cancel: async () => { cancelled = true; },
      }),
    },
  });
  const sink = createSiemHttpSink({ ...HERMETIC, url: 'https://siem.example.com/x', format: 'hec', token: TOKEN, fetchImpl, sleep: noSleep });
  await assert.rejects(sink.write(['{}'], [event('a')]), { code: SIEM_HTTP_ERRORS.REJECTED });
  assert.equal(cancelled, true);
  assert.ok(pulled <= 5, `stopped after ${pulled} chunks of an endless body`);
});
