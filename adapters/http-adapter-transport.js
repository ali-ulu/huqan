'use strict';

// The SSRF-pinned HTTP transport of adapters/http-adapter.js (#2401): one
// request per call with the connection pinned to a validated address, and a
// redirect loop that re-validates every hop.

const http = require('http');
const https = require('https');
const { resolveSafeAddress } = require('../lib/ssrf-guard');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'huqan-http-adapter/1.0 (+https://github.com/ali-ulu/huqan)';
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function pinnedLookup(pinnedAddress, family) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    cb(null, pinnedAddress, family);
  };
}

function setBoundedCache(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

/**
 * Fetches a single URL with the connection pinned to a pre-validated,
 * public address (see lib/ssrf-guard) -- the hostname is never re-resolved
 * at connect time, which is what makes the DNS validation meaningful rather
 * than a check that a rebinding attacker can simply outlast. Does not
 * follow redirects; fetchUrl() does that, re-validating each hop.
 */
async function rawFetch(urlString, options = {}) {
  const safe = await resolveSafeAddress(urlString, options);
  const parsed = new URL(urlString);
  const client = parsed.protocol === 'https:' ? https : http;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let res;
    let settled = false;
    let deadline;
    // Rejecting here directly (rather than via req.destroy(err) and an
    // 'error' listener) avoids destroy()'s error re-emitting synchronously
    // through the in-flight 'data' event dispatch and surfacing as an
    // uncaught exception instead of a clean promise rejection.
    const failOnce = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(err);
      req.destroy();
      res?.destroy();
    };
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      // HEAD is what a reachability probe wants (#348): same URL, same SSRF
      // validation and redirect handling, no body to download or cap.
      method: options.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: {
        'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
        Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
      },
      lookup: pinnedLookup(safe.addresses[0], safe.family),
      timeout: timeoutMs,
    }, (response) => {
      res = response;
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (received > maxBytes) {
          failOnce(Object.assign(new Error(`http-adapter: response exceeded maxBytes (${maxBytes})`), { code: 'HTTP_RESPONSE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', failOnce);
    });
    req.on('timeout', () => {
      failOnce(Object.assign(new Error(`http-adapter: request timed out after ${timeoutMs}ms`), { code: 'HTTP_TIMEOUT' }));
    });
    req.on('error', failOnce);
    deadline = setTimeout(() => {
      failOnce(Object.assign(new Error(`http-adapter: request timed out after ${timeoutMs}ms`), { code: 'HTTP_TIMEOUT' }));
    }, timeoutMs);
    req.end();
  });
}

/**
 * Follows redirects up to maxRedirects, re-running the full SSRF
 * validation on every hop -- a same-origin-looking first response can still
 * redirect to an internal address, so the guard has to run again rather
 * than only once for the URL the caller supplied.
 *
 * `options.onRedirect(nextUrl)` runs before the hop is fetched and may throw
 * to refuse it. Policy that is decided per URL belongs there rather than
 * around this call: the caller's URL says nothing about where it redirects
 * to (#762).
 */
async function fetchUrl(urlString, options = {}) {
  let currentUrl = urlString;
  let redirects = 0;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const onRedirect = typeof options.onRedirect === 'function' ? options.onRedirect : null;

  for (;;) {
    const res = await rawFetch(currentUrl, options);
    if (REDIRECT_STATUS_CODES.has(res.statusCode) && res.headers.location) {
      if (redirects >= maxRedirects) {
        throw Object.assign(new Error(`http-adapter: too many redirects (>${maxRedirects})`), { code: 'HTTP_TOO_MANY_REDIRECTS' });
      }
      currentUrl = new URL(res.headers.location, currentUrl).toString();
      redirects += 1;
      // Before the hop is fetched, never after: refusing a URL we already
      // downloaded would not be a refusal.
      if (onRedirect) await onRedirect(currentUrl);
      continue;
    }
    return { ...res, finalUrl: currentUrl, redirects };
  }
}

module.exports = { fetchUrl, setBoundedCache, DEFAULT_USER_AGENT };
