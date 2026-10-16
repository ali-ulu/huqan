const { learnEntriesAsync, learnEntries } = require('./utils/learn-entries');
const { fetchUrl, setBoundedCache, DEFAULT_USER_AGENT } = require('./http-adapter-transport');
const { parseRobotsDisallow, isAllowedByRobots, assertRobotsAllows } = require('./http-adapter-robots');
const { parseHtml } = require('./http-adapter-html');

// The URL ingest facade (#2401): the SSRF-pinned transport, robots policy and
// HTML parsing live in http-adapter-transport/-robots/-html; this file owns
// the response cache and turning one fetched URL into learnable entries.

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RESPONSE_CACHE_MAX_ENTRIES = 100;

const defaultResponseCache = new Map();

async function ingestUrl(urlString, options = {}) {
  new URL(urlString); // fail fast on a malformed URL before any network/robots work
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  const fetchOptions = { ...options, userAgent };

  const respectRobots = options.respectRobots !== false;
  if (respectRobots) await assertRobotsAllows(urlString, fetchOptions);

  const cache = options.responseCache || defaultResponseCache;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = options.responseCacheMaxEntries ?? DEFAULT_RESPONSE_CACHE_MAX_ENTRIES;
  let cached = cache.get(urlString);
  const cacheFresh = cached && (Date.now() - cached.fetchedAt) < cacheTtlMs;
  if (cached && !cacheFresh) {
    cache.delete(urlString);
    cached = null;
  }
  // Refresh the cache on a miss (no entry OR expired entry), not only when the
  // entry was absent. Previously an expired entry was never replaced, so every
  // subsequent request re-fetched forever.
  // A redirect target is a different source with its own policy, and it may
  // be on a different origin entirely, so each hop is checked against its own
  // robots.txt before it is fetched (#762).
  const result = cacheFresh
    ? cached.result
    : await fetchUrl(urlString, {
      ...fetchOptions,
      onRedirect: respectRobots ? (hopUrl) => assertRobotsAllows(hopUrl, fetchOptions) : undefined,
    });
  if (!cacheFresh) setBoundedCache(cache, urlString, { fetchedAt: Date.now(), result }, maxEntries);
  else setBoundedCache(cache, urlString, cached, maxEntries);

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

  // A URL is a location, and locations keep resolving after the thing behind
  // them changes. Where the server offers a validator, record it: an ETag is the
  // one version identifier HTTP actually gives us. These headers were already
  // being read off the response and thrown away.
  const etag = String(result.headers.etag || result.headers.ETag || '').trim();
  const lastModified = String(result.headers['last-modified'] || '').trim();
  for (const entry of entries) {
    if (etag) entry.etag = etag;
    if (lastModified) entry.lastModified = lastModified;
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

/**
 * Learns a set of already-fetched entries.
 *
 * Split out of ingestAndLearn so the provenance it builds can be exercised
 * without standing up a server: the version-recording behaviour is the part
 * worth testing, and it should not be reachable only through a live fetch.
 */
async function ingestAndLearn(urls, kernel, options = {}) {
  const result = await ingestUrls(urls, options);
  if (!result || !result.entries) return result;
  
  // Custom logic for HTTP adapter's etag/lastModified mapping could go here if needed
  
  return learnEntriesAsync(result, kernel, options, 'api', 'http');
}

module.exports = {
  fetchUrl,
  parseRobotsDisallow,
  isAllowedByRobots,
  assertRobotsAllows,
  parseHtml,
  ingestUrl,
  ingestUrls,
  learnEntries,
  ingestAndLearn,
};
