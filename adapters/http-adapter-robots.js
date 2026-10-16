'use strict';

// robots.txt policy for adapters/http-adapter.js (#2401). robots.txt itself is
// fetched through the same SSRF-pinned transport as every other request.

const { fetchUrl, setBoundedCache, DEFAULT_USER_AGENT } = require('./http-adapter-transport');

const DEFAULT_ROBOTS_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ROBOTS_CACHE_MAX_ENTRIES = 500;

const defaultRobotsCache = new Map();

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
  const maxEntries = options.robotsCacheMaxEntries ?? DEFAULT_ROBOTS_CACHE_MAX_ENTRIES;

  let entry = cache.get(origin);
  if (entry && (Date.now() - entry.fetchedAt) >= ttl) {
    cache.delete(origin);
    entry = null;
  }
  if (!entry) {
    let disallow = [];
    try {
      // `onRedirect` is dropped deliberately: fetching robots.txt is how the
      // robots check is answered, so carrying the check into that fetch would
      // recurse. Every hop still goes through rawFetch's SSRF validation, so
      // dropping it removes no guard.
      const { onRedirect: _ignored, ...robotsOptions } = options;
      const res = await fetchUrl(`${origin}/robots.txt`, { ...robotsOptions, maxBytes: 200 * 1024 });
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
    setBoundedCache(cache, origin, entry, maxEntries);
  } else {
    setBoundedCache(cache, origin, entry, maxEntries);
  }

  return !entry.disallow.some((prefix) => parsed.pathname.startsWith(prefix));
}

/** isAllowedByRobots, raised as the adapter's refusal when the answer is no. */
async function assertRobotsAllows(urlString, options) {
  if (await isAllowedByRobots(urlString, options)) return;
  throw Object.assign(
    new Error(`http-adapter: ${urlString} is disallowed by robots.txt`),
    { code: 'HTTP_ROBOTS_DISALLOWED', url: urlString }
  );
}

module.exports = { parseRobotsDisallow, isAllowedByRobots, assertRobotsAllows };
