const http = require('http');
const https = require('https');
const { resolveSafeAddress } = require('../lib/ssrf-guard');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'huqan-http-adapter/1.0 (+https://github.com/ali-ulu/huqan)';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ROBOTS_CACHE_TTL_MS = 10 * 60 * 1000;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const defaultResponseCache = new Map();
const defaultRobotsCache = new Map();

function pinnedLookup(pinnedAddress, family) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    cb(null, pinnedAddress, family);
  };
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
    }, (res) => {
      const chunks = [];
      let received = 0;
      let settled = false;
      // Rejecting here directly (rather than via req.destroy(err) and an
      // 'error' listener) avoids destroy()'s error re-emitting synchronously
      // through the in-flight 'data' event dispatch and surfacing as an
      // uncaught exception instead of a clean promise rejection.
      const failOnce = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
        req.destroy();
        res.destroy();
      };
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
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', failOnce);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error(`http-adapter: request timed out after ${timeoutMs}ms`), { code: 'HTTP_TIMEOUT' }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Follows redirects up to maxRedirects, re-running the full SSRF
 * validation on every hop -- a same-origin-looking first response can still
 * redirect to an internal address, so the guard has to run again rather
 * than only once for the URL the caller supplied.
 */
async function fetchUrl(urlString, options = {}) {
  let currentUrl = urlString;
  let redirects = 0;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  for (;;) {
    const res = await rawFetch(currentUrl, options);
    if (REDIRECT_STATUS_CODES.has(res.statusCode) && res.headers.location) {
      if (redirects >= maxRedirects) {
        throw Object.assign(new Error(`http-adapter: too many redirects (>${maxRedirects})`), { code: 'HTTP_TOO_MANY_REDIRECTS' });
      }
      currentUrl = new URL(res.headers.location, currentUrl).toString();
      redirects += 1;
      continue;
    }
    return { ...res, finalUrl: currentUrl, redirects };
  }
}

/**
 * Minimal robots.txt parser: groups consecutive User-agent lines into a
 * block, collects Allow/Disallow lines that follow until the next block
 * starts. Prefers a block matching options' userAgent by substring; falls
 * back to the '*' block. Only prefix-matches Disallow paths (no full
 * wildcard/`$` support) -- covers the large majority of real robots.txt
 * files without a full spec implementation.
 */
function parseRobotsDisallow(text, userAgent) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim());
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        blocks.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'disallow' || key === 'allow') && current) {
      current.rules.push({ type: key, path: value });
    }
  }

  const uaLower = String(userAgent || '').toLowerCase();
  const matched = blocks.find((block) => block.agents.some((agent) => agent !== '*' && uaLower.includes(agent)))
    || blocks.find((block) => block.agents.includes('*'));
  if (!matched) return [];
  return matched.rules.filter((rule) => rule.type === 'disallow' && rule.path).map((rule) => rule.path);
}

async function isAllowedByRobots(urlString, options = {}) {
  const parsed = new URL(urlString);
  const origin = parsed.origin;
  const cache = options.robotsCache || defaultRobotsCache;
  const ttl = options.robotsCacheTtlMs ?? DEFAULT_ROBOTS_CACHE_TTL_MS;

  let entry = cache.get(origin);
  if (!entry || (Date.now() - entry.fetchedAt) > ttl) {
    let disallow = [];
    try {
      const res = await fetchUrl(`${origin}/robots.txt`, { ...options, maxBytes: 200 * 1024 });
      if (res.statusCode < 400) {
        disallow = parseRobotsDisallow(res.body.toString('utf8'), options.userAgent || DEFAULT_USER_AGENT);
      }
    } catch (_) {
      // robots.txt unreachable (network error, timeout, blocked by the same
      // SSRF guard) is treated as "no robots.txt present" -- standard
      // crawler behavior is allow-all in that case, not fail-closed.
      disallow = [];
    }
    entry = { fetchedAt: Date.now(), disallow };
    cache.set(origin, entry);
  }

  return !entry.disallow.some((prefix) => parsed.pathname.startsWith(prefix));
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Splits fetched HTML into sections by <h1>-<h3> headings, mirroring
 * markdown-adapter's heading-based model. Falls back to one 'root' entry
 * for the whole page when no headings are found. Regex-based rather than a
 * DOM parser -- this only needs readable text, not layout or a full parse
 * tree, and adding an HTML parsing dependency for that would be scope
 * beyond what the ingest use case needs.
 */
function parseHtml(html, sourceUrl) {
  const body = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const headingMatches = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)];
  if (headingMatches.length === 0) {
    const text = stripTags(body);
    return text ? [{ entryKey: 'root', filePath: sourceUrl, content: text, sourceRef: `${sourceUrl}#root` }] : [];
  }

  const entries = [];
  headingMatches.forEach((match, i) => {
    const heading = stripTags(match[1]) || `section-${i + 1}`;
    const start = match.index + match[0].length;
    const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : body.length;
    const text = stripTags(body.slice(start, end));
    if (!text) return;
    entries.push({
      entryKey: heading,
      filePath: sourceUrl,
      content: text,
      sourceRef: `${sourceUrl}#${encodeURIComponent(heading)}`,
    });
  });
  return entries;
}

async function ingestUrl(urlString, options = {}) {
  new URL(urlString); // fail fast on a malformed URL before any network/robots work
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  const fetchOptions = { ...options, userAgent };

  if (options.respectRobots !== false) {
    const allowed = await isAllowedByRobots(urlString, fetchOptions);
    if (!allowed) {
      throw Object.assign(new Error(`http-adapter: ${urlString} is disallowed by robots.txt`), { code: 'HTTP_ROBOTS_DISALLOWED' });
    }
  }

  const cache = options.responseCache || defaultResponseCache;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = cache.get(urlString);
  const cacheFresh = cached && (Date.now() - cached.fetchedAt) < cacheTtlMs;
  // Refresh the cache on a miss (no entry OR expired entry), not only when the
  // entry was absent. Previously an expired entry was never replaced, so every
  // subsequent request re-fetched forever.
  const result = cacheFresh
    ? cached.result
    : await fetchUrl(urlString, fetchOptions);
  if (!cacheFresh) cache.set(urlString, { fetchedAt: Date.now(), result });

  if (result.statusCode >= 400) {
    throw Object.assign(
      new Error(`http-adapter: ${urlString} returned HTTP ${result.statusCode}`),
      { code: 'HTTP_FETCH_FAILED', statusCode: result.statusCode }
    );
  }

  const contentType = String(result.headers['content-type'] || '').toLowerCase();
  const finalUrl = result.finalUrl || urlString;
  const bodyText = result.body.toString('utf8');

  let entries;
  if (contentType.includes('text/html') || (!contentType && /<html/i.test(bodyText))) {
    entries = parseHtml(bodyText, finalUrl);
  } else if (contentType === '' || contentType.includes('text/plain')) {
    const text = bodyText.trim();
    entries = text ? [{ entryKey: 'root', filePath: finalUrl, content: text, sourceRef: `${finalUrl}#root` }] : [];
  } else {
    throw Object.assign(
      new Error(`http-adapter: unsupported content-type "${contentType}" for ${urlString}`),
      { code: 'HTTP_UNSUPPORTED_CONTENT_TYPE' }
    );
  }

  return { url: urlString, finalUrl, statusCode: result.statusCode, entries };
}

async function ingestUrls(urls, options = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  const results = [];
  const errors = [];
  for (const url of list) {
    try {
      results.push(await ingestUrl(url, options));
    } catch (e) {
      errors.push({ url, error: e.message, code: e.code });
    }
  }
  return {
    urls: list,
    results,
    entries: results.flatMap((r) => r.entries),
    errors,
  };
}

async function ingestAndLearn(urls, kernel, options = {}) {
  const result = await ingestUrls(urls, options);
  const learned = [];
  for (const entry of result.entries) {
    const provenance = {
      provenanceId: `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'http-adapter',
      sourceRef: entry.sourceRef,
      sourceType: 'http',
      actor: options.actor || 'http-adapter',
      timestamp: new Date().toISOString(),
    };
    try {
      const r = kernel.learn(entry.content, { provenance, sourceType: 'http', sourceRef: provenance.sourceRef });
      learned.push({ entryKey: entry.entryKey, learned: r.data.learned, ok: true });
    } catch (e) {
      learned.push({ entryKey: entry.entryKey, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

module.exports = {
  fetchUrl,
  parseRobotsDisallow,
  isAllowedByRobots,
  parseHtml,
  ingestUrl,
  ingestUrls,
  ingestAndLearn,
};
