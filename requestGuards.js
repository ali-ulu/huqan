const crypto = require('crypto');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');
const commandPolicy = require('./requestGuards-command-policy');
const rateLimit = require('./requestGuards-rate-limit');
const body = require('./requestGuards-body');

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

const API_AUTH_OPT_OUT_VALUES = new Set(['true', '1']);
let apiAuthOptOutAnnounced = false;

// Single-operator installs that bind to loopback can trade the API key for
// convenience. The opt-out is deliberately explicit and off by default, so a
// fresh clone is never served unauthenticated by accident.
function isApiAuthDisabled() {
  const raw = readCompatibleEnvironmentVariable('DISABLE_API_AUTH') || '';
  return API_AUTH_OPT_OUT_VALUES.has(String(raw).trim().toLowerCase());
}

function requireApiKey(req, configuredKey = readCompatibleEnvironmentVariable('API_KEY') || '') {
  if (isApiAuthDisabled()) {
    if (!apiAuthOptOutAnnounced) {
      apiAuthOptOutAnnounced = true;
      console.warn('[auth] HUQAN_DISABLE_API_AUTH is set; every API request is served without authentication');
    }
    return { ok: true };
  }

  const apiKey = commandPolicy.sanitizeInput(configuredKey, 256);
  const provided = extractApiKey(req.headers || {});

  if (!apiKey || !provided || !constantTimeEqual(provided, apiKey)) {
    if (!apiKey) {
      console.error('[auth] HUQAN_API_KEY is not configured; rejecting request');
    }
    return {
      ok: false,
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
      // One envelope for both branches. The viewer gateway has always answered
      // { ok:false, error:{ code, message } } while this branch answered a bare
      // string, so the same rejection had two shapes depending on which half of
      // the server a client reached (#1994). The browser clients already read
      // `body.error?.code` and `body.error?.message`, so the string was landing
      // as undefined and falling back to "HTTP 401" -- converging here is what
      // they were written for.
      error: { ok: false, error: { code: 'unauthorized', message: 'Unauthorized' } },
    };
  }

  return { ok: true };
}

module.exports = {
  DEFAULT_MAX_INPUT_LENGTH: commandPolicy.DEFAULT_MAX_INPUT_LENGTH,
  DEFAULT_MAX_JSON_BODY: body.DEFAULT_MAX_JSON_BODY,
  DEFAULT_MAX_UPLOAD_BODY: body.DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_RATE_LIMIT_MAX: rateLimit.DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES: rateLimit.DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  DEFAULT_RATE_LIMIT_WINDOW: rateLimit.DEFAULT_RATE_LIMIT_WINDOW,
  DEFAULT_ALLOWED_PUBLIC_COMMANDS: commandPolicy.DEFAULT_ALLOWED_PUBLIC_COMMANDS,
  UNAUTHENTICATED_PUBLIC_COMMANDS: commandPolicy.UNAUTHENTICATED_PUBLIC_COMMANDS,
  AUTHENTICATED_API_COMMANDS: commandPolicy.AUTHENTICATED_API_COMMANDS,
  clearExpiredRateLimitEntries: rateLimit.clearExpiredRateLimitEntries,
  checkRateLimit: rateLimit.checkRateLimit,
  commandRequiresAuthentication: commandPolicy.commandRequiresAuthentication,
  constantTimeEqual,
  enforceRateLimitCap: rateLimit.enforceRateLimitCap,
  extractApiKey,
  isAllowedPublicCommand: commandPolicy.isAllowedPublicCommand,
  isApiAuthDisabled,
  isUnsafePublicApiCommand: commandPolicy.isUnsafePublicApiCommand,
  readJsonBody: body.readJsonBody,
  rateLimitMap: rateLimit.rateLimitMap,
  requireApiKey,
  normalizePublicApiCommandText: commandPolicy.normalizePublicApiCommandText,
  sanitizeInput: commandPolicy.sanitizeInput,
};
