'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const {
  buildSetCookie,
  buildClearCookie,
  parseSessionCookie,
  isSameOriginRequest,
} = require('./session-cookie');
const { sanitizeInput } = require('../../requestGuards');

const VIEWER_PREFIX = '/viewer';
const SESSION_PATH = '/viewer/session';
const RECEIPT_PREFIX = '/viewer/api/trust-receipt/';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const MAX_LOGIN_BODY_BYTES = 1024;
const MAX_RECEIPT_ID_LENGTH = 128;

function isViewerPath(pathname) {
  return pathname === VIEWER_PREFIX || pathname.startsWith(`${VIEWER_PREFIX}/`);
}

function writeJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Cache-Control': 'no-store',
    Vary: 'Cookie',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function writeEmpty(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    Vary: 'Cookie',
    ...headers,
  });
  res.end();
}

function fail(res, statusCode, code, message, headers = {}) {
  writeJson(res, statusCode, { ok: false, error: { code, message } }, headers);
}

function secureEqual(left, right) {
  const leftDigest = createHash('sha256').update(String(left)).digest();
  const rightDigest = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '::1'
    || value.startsWith('127.')
    || value.startsWith('::ffff:127.');
}

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.includes('/') || hostHeader.includes('\\')) {
    return false;
  }
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function useInsecureLoopback(req, enabled) {
  return enabled
    && isLoopbackAddress(req.socket?.localAddress)
    && isLoopbackHost(req.headers?.host);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_LOGIN_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        resolve({ ok: false, status: 413, code: 'payload_too_large', message: 'Request body is too large' });
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve({ ok: true, value });
      } catch {
        resolve({ ok: false, status: 400, code: 'invalid_json', message: 'Request body must be valid JSON' });
      }
    });
    req.on('error', () => {
      resolve({ ok: false, status: 400, code: 'invalid_request', message: 'Request body could not be read' });
    });
  });
}

function readReceiptId(pathname) {
  if (!pathname.startsWith(RECEIPT_PREFIX)) return null;
  const raw = pathname.slice(RECEIPT_PREFIX.length);
  if (!raw) return { ok: false };
  try {
    const receiptId = decodeURIComponent(raw).trim();
    if (!receiptId || receiptId.length > MAX_RECEIPT_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(receiptId)) {
      return { ok: false };
    }
    return { ok: true, receiptId };
  } catch {
    return { ok: false };
  }
}

function createViewerGateway({
  sessionStore,
  readReceipt,
  configuredKey = () => process.env.AXIOM_API_KEY || '',
  allowInsecureLoopback = () => process.env.AXIOM_VIEWER_INSECURE_LOOPBACK === '1',
} = {}) {
  if (!sessionStore || typeof sessionStore.create !== 'function' || typeof sessionStore.validate !== 'function') {
    throw new TypeError('sessionStore is required');
  }
  if (typeof readReceipt !== 'function') throw new TypeError('readReceipt is required');

  function requestSecurity(req) {
    const insecureLoopback = useInsecureLoopback(req, allowInsecureLoopback());
    return { secure: !insecureLoopback, allowInsecureLoopback: insecureLoopback };
  }

  function sessionId(req, secure) {
    return parseSessionCookie(req.headers?.cookie, { secure });
  }

  async function login(req, res) {
    const security = requestSecurity(req);
    if (!isSameOriginRequest({
      originHeader: req.headers?.origin,
      hostHeader: req.headers?.host,
      allowInsecureLoopback: security.allowInsecureLoopback,
    })) {
      fail(res, 403, 'cross_origin', 'A strict same-origin request is required');
      return;
    }
    const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      fail(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
      return;
    }

    const body = await readJsonBody(req);
    if (!body.ok) {
      fail(res, body.status, body.code, body.message);
      return;
    }
    const suppliedKey = body.value && typeof body.value === 'object' ? body.value.apiKey : '';
    const expectedKey = configuredKey();
    if (typeof suppliedKey !== 'string' || !suppliedKey || typeof expectedKey !== 'string' || !expectedKey
      || !secureEqual(suppliedKey, expectedKey)) {
      fail(res, 401, 'unauthorized', 'Invalid credentials');
      return;
    }

    sessionStore.destroy(sessionId(req, security.secure));
    const session = sessionStore.create();
    writeJson(res, 200, { ok: true, expiresAt: session.expiresAt }, {
      'Set-Cookie': buildSetCookie({
        sessionId: session.sessionId,
        secure: security.secure,
        maxAgeSeconds: session.maxAgeSeconds,
      }),
    });
  }

  function logout(req, res) {
    const security = requestSecurity(req);
    if (!isSameOriginRequest({
      originHeader: req.headers?.origin,
      hostHeader: req.headers?.host,
      allowInsecureLoopback: security.allowInsecureLoopback,
    })) {
      fail(res, 403, 'cross_origin', 'A strict same-origin request is required');
      return;
    }
    sessionStore.destroy(sessionId(req, security.secure));
    writeEmpty(res, 204, { 'Set-Cookie': buildClearCookie({ secure: security.secure }) });
  }

  function read(req, res, reqUrl, receiptRequest) {
    const security = requestSecurity(req);
    const token = sessionId(req, security.secure);
    const validation = sessionStore.validate(token);
    if (!validation.ok) {
      fail(res, 401, 'unauthorized', 'A valid viewer session is required', {
        'Set-Cookie': buildClearCookie({ secure: security.secure }),
      });
      return;
    }
    if (!receiptRequest.ok) {
      fail(res, 400, 'invalid_receipt_id', 'receiptId must be a non-empty string');
      return;
    }

    const workspaceId = sanitizeInput(reqUrl.searchParams.get('workspaceId') || '', MAX_RECEIPT_ID_LENGTH);
    let result;
    try {
      result = readReceipt(receiptRequest.receiptId, workspaceId ? { workspaceId } : {});
    } catch {
      fail(res, 500, 'receipt_read_failed', 'receipt could not be read');
      return;
    }
    if (!result || result.ok !== true) {
      const notFound = result?.status === 'not_found';
      fail(
        res,
        notFound ? 404 : 400,
        notFound ? 'receipt_not_found' : 'invalid_receipt_id',
        notFound ? 'receipt not found' : 'receiptId must be a non-empty string',
      );
      return;
    }
    writeJson(res, 200, { ok: true, receipt: result.receipt });
  }

  async function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (pathname === SESSION_PATH) {
      if (req.method === 'POST') return login(req, res);
      if (req.method === 'DELETE') return logout(req, res);
      fail(res, 405, 'method_not_allowed', 'Method not allowed', { Allow: 'POST, DELETE' });
      return undefined;
    }

    const receiptRequest = readReceiptId(pathname);
    if (receiptRequest) {
      if (req.method !== 'GET') {
        fail(res, 405, 'method_not_allowed', 'Method not allowed', { Allow: 'GET' });
        return undefined;
      }
      return read(req, res, reqUrl, receiptRequest);
    }

    fail(res, 404, 'not_found', 'Viewer route not found');
    return undefined;
  }

  return { isViewerPath, handle };
}

module.exports = {
  createViewerGateway,
  VIEWER_PREFIX,
  SESSION_PATH,
  RECEIPT_PREFIX,
};
