const crypto = require('crypto');

const DEFAULT_MAX_INPUT_LENGTH = 500;
const DEFAULT_RATE_LIMIT_WINDOW = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_MAX_JSON_BODY = 4_096;
const DEFAULT_MAX_UPLOAD_BODY = 1_048_576;

const rateLimitMap = new Map();

function sanitizeInput(raw, maxLength = DEFAULT_MAX_INPUT_LENGTH) {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, maxLength);
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return s.trim();
}

function checkRateLimit(ip, now = Date.now(), windowMs = DEFAULT_RATE_LIMIT_WINDOW, maxRequests = DEFAULT_RATE_LIMIT_MAX) {
  const key = String(ip || 'unknown');
  let entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
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
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, configuredKey = process.env.AXIOM_API_KEY || '') {
  const apiKey = sanitizeInput(configuredKey, 256);
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
      error: { error: 'API key not configured' },
    };
  }

  const provided = extractApiKey(req.headers || {});
  if (!provided || !constantTimeEqual(provided, apiKey)) {
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
      error: { error: 'İçerik çok büyük' },
    };
  }

  let body = '';
  let size = 0;

  return await new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        finish({ ok: false, status: 413, error: { error: 'İçerik çok büyük' } });
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
  DEFAULT_RATE_LIMIT_WINDOW,
  clearExpiredRateLimitEntries,
  checkRateLimit,
  extractApiKey,
  readJsonBody,
  rateLimitMap,
  requireApiKey,
  sanitizeInput,
};
