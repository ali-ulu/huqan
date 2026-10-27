// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * The HTTPS push transport for the SIEM export (#4093, PR-B4).
 *
 * Opt-in only: the default transport is the local file (PR-B3), which needs no
 * network. An operator who names an HTTPS endpoint gets one of the two bulk
 * APIs a SIEM actually ingests, chosen by the format they already render:
 *
 * - `hec`: Splunk HTTP Event Collector. The body is the rendered HEC envelopes,
 *   one per line, with `Authorization: Splunk <token>`. HEC cannot deduplicate:
 *   a backlog larger than one batch that fails part-way is re-sent from the
 *   start next run, so duplicates (same `event.id`) are expected there.
 * - `ecs`: Elastic `_bulk`. Each event is a `create` under its own `event.id`,
 *   so an event Elastic already holds comes back 409 and counts as delivered:
 *   the export is at-least-once, and the id makes the duplicate harmless.
 *   `Authorization: ApiKey <token>`.
 *
 * What this module owns:
 *
 * - **The destination is judged before the sink exists.** The factory runs
 *   lib/siem/siem-push-policy.js (AB12 residency, AB13 expected egress) on the
 *   endpoint's host, so no caller can hold an HTTP sink that skipped it
 *   (INV-B6). Redirects are refused rather than followed: a 3xx would move the
 *   events to a host nobody judged.
 * - **A failed delivery throws.** The export advances its cursor only when
 *   `write` returns, so a refused, exhausted or partly rejected delivery leaves
 *   every event pending for the next run (INV-B4). An Elastic `_bulk` answer of
 *   200 with a rejected item is a failure, not a success.
 * - **HTTPS only, verified, secret in a header.** No plain HTTP, and no
 *   credentials, query or fragment in the URL (INV-B5), by the rules the
 *   observability webhook already follows (lib/https-delivery-rules.js). The
 *   sink refuses to start when `NODE_TLS_REJECT_UNAUTHORIZED=0` would make
 *   `fetch` skip certificate checks. The token lives in a closure and is never
 *   put on the sink object, in a message, or in a report.
 * - **The retry rules are the shared ones**, not a second policy. The timeout
 *   covers the whole exchange, response body included, and every body is read
 *   so no connection is left half-consumed.
 */

const {
  isRetryableError,
  isRetryableStatus,
  normalizeHttpsUrl,
  retryAfterMs,
} = require('../https-delivery-rules');
const { assertPushDestinationAllowed } = require('./siem-push-policy');

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
// One request per this many events, so a long backlog is not one unbounded body.
const DEFAULT_MAX_BATCH_EVENTS = 500;
// A collector's answer is a status document; anything larger is not one.
const MAX_RESPONSE_CHARS = 1024 * 1024;

const SIEM_HTTP_FORMATS = Object.freeze(['hec', 'ecs']);

const SIEM_HTTP_ERRORS = Object.freeze({
  INVALID_CONFIG: 'SIEM_HTTP_INVALID_CONFIG',
  TOKEN_REQUIRED: 'SIEM_HTTP_TOKEN_REQUIRED',
  TLS_VERIFICATION_DISABLED: 'SIEM_HTTP_TLS_VERIFICATION_DISABLED',
  UNSUPPORTED_FORMAT: 'SIEM_HTTP_UNSUPPORTED_FORMAT',
  REJECTED: 'SIEM_HTTP_REJECTED',
  RETRY_EXHAUSTED: 'SIEM_HTTP_RETRY_EXHAUSTED',
  BULK_ITEM_FAILED: 'SIEM_HTTP_BULK_ITEM_FAILED',
  TIMEOUT: 'SIEM_HTTP_TIMEOUT',
  FAILED: 'SIEM_HTTP_FAILED',
});

function sinkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}

function hecRequest(lines) {
  return { body: lines.join('\n'), contentType: 'application/json' };
}

function bulkRequest(lines, events) {
  const body = lines.map((line, index) => {
    const id = String((events[index] && events[index]['event.id']) || '');
    // Without an id Elastic would invent one, and a re-run would duplicate the event.
    if (!id) throw sinkError(SIEM_HTTP_ERRORS.INVALID_CONFIG, 'every SIEM event needs an event.id to be created in Elastic');
    return `${JSON.stringify({ create: { _id: id } })}\n${line}\n`;
  }).join('');
  return { body, contentType: 'application/x-ndjson' };
}

/** An Elastic `_bulk` answer: every item created, or already there (409). */
function assertBulkAccepted(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw sinkError(SIEM_HTTP_ERRORS.BULK_ITEM_FAILED, 'Elastic _bulk answered without a readable result');
  }
  if (!parsed || parsed.errors !== true) return;
  const failed = (Array.isArray(parsed.items) ? parsed.items : [])
    .map(item => Number(item && item.create && item.create.status))
    .filter(status => !(status >= 200 && status < 300) && status !== 409);
  if (failed.length > 0) {
    throw sinkError(SIEM_HTTP_ERRORS.BULK_ITEM_FAILED, `Elastic _bulk rejected ${failed.length} event(s) (status ${failed[0]})`);
  }
}

function chunks(items, size) {
  const out = [];
  for (let start = 0; start < items.length; start += size) out.push([start, start + size]);
  return out;
}

function oversized() {
  return sinkError(SIEM_HTTP_ERRORS.REJECTED, `SIEM endpoint answered with more than ${MAX_RESPONSE_CHARS} bytes`);
}

/** The answer, read as a stream and cut off at the cap, so a large body is never buffered. */
async function readBody(response) {
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) {
    const text = typeof response.text === 'function' ? String(await response.text()) : '';
    if (text.length > MAX_RESPONSE_CHARS) throw oversized();
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_CHARS) {
      await reader.cancel().catch(() => {});
      throw oversized();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validatedConfig({ url, format, token, environment, fetchImpl }) {
  const endpoint = normalizeHttpsUrl(url, message => sinkError(SIEM_HTTP_ERRORS.INVALID_CONFIG, message), 'SIEM endpoint URL');
  if (!SIEM_HTTP_FORMATS.includes(format)) {
    throw sinkError(SIEM_HTTP_ERRORS.UNSUPPORTED_FORMAT, `the http sink sends hec (Splunk) or ecs (Elastic _bulk), not ${String(format)}`);
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw sinkError(SIEM_HTTP_ERRORS.TOKEN_REQUIRED, 'the http sink needs a token; set HUQAN_SIEM_HTTP_TOKEN');
  }
  // `fetch` reads the live process environment, whatever environment the caller passed.
  if ([environment, process.env].some(env => String((env && env.NODE_TLS_REJECT_UNAUTHORIZED) || '').trim() === '0')) {
    throw sinkError(SIEM_HTTP_ERRORS.TLS_VERIFICATION_DISABLED, 'NODE_TLS_REJECT_UNAUTHORIZED=0 would send the token and the events without certificate checks; unset it for the SIEM export');
  }
  if (typeof fetchImpl !== 'function') throw sinkError(SIEM_HTTP_ERRORS.INVALID_CONFIG, 'a fetch implementation is required');
  return endpoint;
}

/**
 * @param {object} options
 * @param {string} options.url the collector endpoint (HTTPS, no credentials)
 * @param {'hec'|'ecs'} options.format
 * @param {string} options.token the HEC token or Elastic API key
 * @param {object} [options.environment] read for TLS settings and AB13
 * @param {string} [options.policyPath] / dataResidency / expectedEgress / allowReview: see siem-push-policy
 * @returns {{kind: 'http', path: string, host: string, policy: object, write: Function}}
 */
function createSiemHttpSink({
  url,
  format,
  token,
  environment = process.env,
  policyPath,
  dataResidency,
  expectedEgress,
  allowReview = false,
  fetchImpl = globalThis.fetch,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxBatchEvents = DEFAULT_MAX_BATCH_EVENTS,
} = {}) {
  const endpoint = validatedConfig({ url, format, token, environment, fetchImpl });
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  const policy = assertPushDestinationAllowed({ host, policyPath, dataResidency, expectedEgress, allowReview, environment });
  const authorization = format === 'hec' ? `Splunk ${token.trim()}` : `ApiKey ${token.trim()}`;
  const attemptsLimit = boundedInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS);
  const timeout = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
  const backoff = boundedInteger(backoffMs, DEFAULT_BACKOFF_MS, 0, MAX_BACKOFF_MS);
  const batchSize = boundedInteger(maxBatchEvents, DEFAULT_MAX_BATCH_EVENTS, 1, 10_000);
  const pause = attempt => Math.min(backoff * (2 ** (attempt - 1)), backoff * 16);

  /** One exchange, body included, under one timeout: `{ status, retryAfter, text }`. */
  async function exchange(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: authorization,
          'Content-Type': request.contentType,
          'User-Agent': 'HUQAN-SIEM-Export/1',
        },
        body: request.body,
        redirect: 'error',
        signal: controller.signal,
      });
      const status = Number((response && response.status) || 0);
      return { status, retryAfter: retryAfterMs(response, backoff * 16), text: await readBody(response) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function deliver(request) {
    for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
      let answer;
      try {
        answer = await exchange(request);
      } catch (error) {
        if (error && error.code === SIEM_HTTP_ERRORS.REJECTED) throw error;
        if (attempt === attemptsLimit || !isRetryableError(error)) {
          const code = error && error.name === 'AbortError' ? SIEM_HTTP_ERRORS.TIMEOUT : SIEM_HTTP_ERRORS.FAILED;
          // The name only: a network error's message can echo request details.
          throw sinkError(code, `SIEM endpoint unreachable after ${attempt} attempt(s): ${String((error && error.name) || 'Error')}`);
        }
        await sleep(pause(attempt));
        continue;
      }
      if (answer.status >= 200 && answer.status < 300) return answer.text;
      if (!isRetryableStatus(answer.status)) {
        throw sinkError(SIEM_HTTP_ERRORS.REJECTED, `SIEM endpoint refused the events (status ${answer.status})`);
      }
      if (attempt === attemptsLimit) {
        throw sinkError(SIEM_HTTP_ERRORS.RETRY_EXHAUSTED, `SIEM endpoint still unavailable after ${attempt} attempt(s) (status ${answer.status})`);
      }
      await sleep(answer.retryAfter ?? pause(attempt));
    }
    throw sinkError(SIEM_HTTP_ERRORS.RETRY_EXHAUSTED, 'SIEM endpoint unavailable');
  }

  async function write(lines, events = []) {
    let requests = 0;
    for (const [start, end] of chunks(lines, batchSize)) {
      const slice = lines.slice(start, end);
      const request = format === 'hec' ? hecRequest(slice) : bulkRequest(slice, events.slice(start, end));
      const text = await deliver(request);
      if (format === 'ecs') assertBulkAccepted(text);
      requests += 1;
    }
    return { delivered: lines.length, requests };
  }

  return Object.freeze({ kind: 'http', path: endpoint, host, policy, write });
}

module.exports = {
  DEFAULT_MAX_BATCH_EVENTS,
  SIEM_HTTP_ERRORS,
  SIEM_HTTP_FORMATS,
  createSiemHttpSink,
};
