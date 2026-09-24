const DEFAULT_RATE_LIMIT_WINDOW = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_MAX_ENTRIES = 2_048;

const rateLimitMap = new Map();

function sortRateLimitEntriesForEviction(entries = []) {
  return entries.sort((left, right) => {
    const resetComparison = Number(left[1]?.resetAt || 0) - Number(right[1]?.resetAt || 0);
    if (resetComparison !== 0) return resetComparison;
    const countComparison = Number(left[1]?.count || 0) - Number(right[1]?.count || 0);
    if (countComparison !== 0) return countComparison;
    return String(left[0] || '').localeCompare(String(right[0] || ''));
  });
}

function enforceRateLimitCap(now = Date.now(), maxEntries = DEFAULT_RATE_LIMIT_MAX_ENTRIES) {
  const cap = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : DEFAULT_RATE_LIMIT_MAX_ENTRIES;
  clearExpiredRateLimitEntries(now);
  if (rateLimitMap.size <= cap) return;

  const entries = sortRateLimitEntriesForEviction([...rateLimitMap.entries()]);
  const overflow = rateLimitMap.size - cap;
  for (let index = 0; index < overflow && index < entries.length; index += 1) {
    rateLimitMap.delete(entries[index][0]);
  }
}

function checkRateLimit(
  ip,
  now = Date.now(),
  windowMs = DEFAULT_RATE_LIMIT_WINDOW,
  maxRequests = DEFAULT_RATE_LIMIT_MAX,
  maxEntries = DEFAULT_RATE_LIMIT_MAX_ENTRIES,
) {
  if (!ip) return false;

  const key = String(ip);
  let entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    const cap = Number.isFinite(maxEntries)
      ? Math.max(0, Math.floor(maxEntries))
      : DEFAULT_RATE_LIMIT_MAX_ENTRIES;
    clearExpiredRateLimitEntries(now);
    if (rateLimitMap.size >= cap) return false;
    entry = { count: 0, resetAt: now + windowMs };
    rateLimitMap.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= maxRequests;
}

function clearExpiredRateLimitEntries(now = Date.now()) {
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}

module.exports = {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  DEFAULT_RATE_LIMIT_WINDOW,
  clearExpiredRateLimitEntries,
  checkRateLimit,
  enforceRateLimitCap,
  rateLimitMap,
};
