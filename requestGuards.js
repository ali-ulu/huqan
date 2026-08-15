const crypto = require('crypto');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');

const DEFAULT_MAX_INPUT_LENGTH = 500;
const DEFAULT_RATE_LIMIT_WINDOW = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_MAX_ENTRIES = 2_048;
const DEFAULT_MAX_JSON_BODY = 4_096;
const DEFAULT_MAX_UPLOAD_BODY = 1_048_576;

const rateLimitMap = new Map();
const UNSAFE_PUBLIC_API_COMMANDS = Object.freeze([
  'restore',
  'geri yukle',
  'yukle',
  'ogren',
  'ogret',
  'load',
  'import',
  'ingest',
  'company ingest',
  'kaydet',
  'learn',
  'delete',
  'remove',
  'tombstone',
  'supersede',
  'link',
  'backup',
  'export',
  'dusun',
  'autothink',
  'dusunmeye basla',
  'surekli dusun',
  'optimize',
  'konsolide',
  'evolve',
  'ajan',
  'plan',
  'listele',
  'kimler',
  'neler',
]);

/**
 * Commands that answer from a fixed string and never touch workspace state.
 * These are the only ones an unauthenticated caller may run (issue #727).
 */
const UNAUTHENTICATED_PUBLIC_COMMANDS = Object.freeze(new Set([
  'selam',
  'yardim',
  'anlamadim',
]));

/**
 * Commands that are readable over the API surface but read live workspace
 * knowledge, so they require an API key:
 *
 *   sor   -> kernel.ask(), i.e. learned answers from the default workspace
 *   durum -> graph stats plus disconnected-node and contradiction labels
 *
 * They used to sit in the unauthenticated allowlist, which let any caller that
 * could reach the port query learned knowledge and enumerate node names.
 */
const AUTHENTICATED_API_COMMANDS = Object.freeze(new Set([
  'sor',
  'durum',
]));

/**
 * Every command the /api surface may dispatch at all, regardless of auth.
 * Authorization within this set is decided by commandRequiresAuthentication().
 */
const DEFAULT_ALLOWED_PUBLIC_COMMANDS = Object.freeze(new Set([
  ...UNAUTHENTICATED_PUBLIC_COMMANDS,
  ...AUTHENTICATED_API_COMMANDS,
]));

function sanitizeInput(raw, maxLength = DEFAULT_MAX_INPUT_LENGTH) {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, maxLength);
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return s.trim();
}

function normalizePublicApiCommandText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\uFEFF/g, '')
    .trim()
    .toLowerCase()
    .replace(/[ç]/g, 'c')
    .replace(/[ğ]/g, 'g')
    .replace(/[ı]/g, 'i')
    .replace(/[ö]/g, 'o')
    .replace(/[ş]/g, 's')
    .replace(/[ü]/g, 'u')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUnsafePublicApiCommand(input) {
  const text = normalizePublicApiCommandText(input);
  if (!text) return false;
  return UNSAFE_PUBLIC_API_COMMANDS.some((command) => {
    return text === command || text.startsWith(`${command}:`) || text.startsWith(`${command} `);
  });
}

function isAllowedPublicCommand(command, allowedSet = DEFAULT_ALLOWED_PUBLIC_COMMANDS) {
  if (typeof command !== 'string' || !command) return false;
  const normalized = normalizePublicApiCommandText(command);
  if (!normalized) return false;
  return allowedSet.has(normalized);
}

/**
 * True when the command reads workspace-backed state and therefore may only run
 * for an authenticated caller.
 *
 * Fails closed: anything that does not normalize into the explicitly
 * unauthenticated set is treated as needing a key, so a command added to the
 * allowlist later does not become publicly readable by omission.
 */
function commandRequiresAuthentication(command, publicSet = UNAUTHENTICATED_PUBLIC_COMMANDS) {
  const normalized = normalizePublicApiCommandText(command);
  if (!normalized) return true;
  return !publicSet.has(normalized);
}

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

function extractApiKey(headers = {}) {
  const auth = headers.authorization || headers.Authorization || '';
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  const headerKey = headers['x-api-key'] || headers['X-API-Key'] || headers['X-API-Key'.toLowerCase()];
  if (Array.isArray(headerKey)) return String(headerKey[0] || '').trim();
  if (typeof headerKey === 'string') return headerKey.trim();
  return '';
}

function constantTimeEqual(left, right) {
  // Hash both operands so compared buffers always have identical length.
  // A raw length check would leak the configured secret's length via timing.
  const a = crypto.createHash('sha256').update(String(left == null ? '' : left), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(right == null ? '' : right), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, configuredKey = readCompatibleEnvironmentVariable('API_KEY') || '') {
  const apiKey = sanitizeInput(configuredKey, 256);
  const provided = extractApiKey(req.headers || {});

  if (!apiKey || !provided || !constantTimeEqual(provided, apiKey)) {
    if (!apiKey) {
      console.error('[auth] HUQAN_API_KEY is not configured; rejecting request');
    }
    return {
      ok: false,
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
      error: { error: 'Unauthorized' },
    };
  }

  return { ok: true };
}

async function readJsonBody(req, { maxBytes = DEFAULT_MAX_JSON_BODY, requireJson = true } = {}) {
  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  if (requireJson && !contentType.includes('application/json')) {
    return {
      ok: false,
      status: 415,
      error: { error: 'Content-Type application/json required' },
    };
  }

  const declaredLength = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: { error: 'Payload too large' },
    };
  }

  let body = '';
  let size = 0;

  return await new Promise(resolve => {
    let settled = false;
    let overflowed = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', chunk => {
      if (overflowed) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop buffering, but do NOT destroy the request (#749).
        //
        // req.destroy() closed the socket before the route could write the 413
        // this function had just promised it, so a chunked client saw
        // ECONNRESET / socket hang up instead — the Content-Length fast path
        // above returned a clean 413 while the streaming path did not, making
        // the size limit transport-dependent. A caller cannot tell a policy
        // rejection from a transport failure, and retries on the latter
        // amplify load.
        //
        // Releasing the buffer here is what actually bounds memory; the
        // remaining inbound bytes are ignored, and the route writes its
        // response and closes the connection normally.
        overflowed = true;
        body = '';
        finish({ ok: false, status: 413, error: { error: 'Payload too large' } });
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (settled) return;
      try {
        const parsed = body ? JSON.parse(body) : {};
        finish({ ok: true, data: parsed });
      } catch (err) {
        finish({ ok: false, status: 400, error: { error: 'Invalid JSON: ' + err.message } });
      }
    });

    // A late error after an overflow (the peer giving up once we stop reading,
    // for instance) must not turn the settled 413 into a 400. finish() already
    // guards that; this keeps the listener from throwing on an unhandled
    // 'error' event.
    req.on('error', err => {
      finish({ ok: false, status: 400, error: { error: 'Request error: ' + err.message } });
    });
  });
}

module.exports = {
  DEFAULT_MAX_INPUT_LENGTH,
  DEFAULT_MAX_JSON_BODY,
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  DEFAULT_RATE_LIMIT_WINDOW,
  DEFAULT_ALLOWED_PUBLIC_COMMANDS,
  UNAUTHENTICATED_PUBLIC_COMMANDS,
  AUTHENTICATED_API_COMMANDS,
  clearExpiredRateLimitEntries,
  checkRateLimit,
  commandRequiresAuthentication,
  constantTimeEqual,
  enforceRateLimitCap,
  extractApiKey,
  isAllowedPublicCommand,
  isUnsafePublicApiCommand,
  readJsonBody,
  rateLimitMap,
  requireApiKey,
  normalizePublicApiCommandText,
  sanitizeInput,
};
