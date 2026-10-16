'use strict';

const {
  buildSetCookie,
  buildClearCookie,
  parseSessionCookie,
  isSameOriginRequest,
} = require('./session-cookie');
const { sanitizeInput } = require('../../requestGuards');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const {
  VIEWER_PREFIX,
  SESSION_PATH,
  RECEIPT_PREFIX,
  MAX_RECEIPT_ID_LENGTH,
  STATIC_ASSETS,
  isViewerPath,
  writeJson,
  writeEmpty,
  writeAsset,
  fail,
  secureEqual,
  useInsecureLoopback,
  readJsonBody,
  readReceiptId,
} = require('./viewer-gateway-primitives');

function createViewerGateway({
  sessionStore,
  readReceipt,
  configuredKey = () => readCompatibleEnvironmentVariable('API_KEY') || '',
  allowInsecureLoopback = () => readCompatibleEnvironmentVariable('VIEWER_INSECURE_LOOPBACK') === '1',
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

    const requestedWorkspaceId = sanitizeInput(
      body.value && typeof body.value.workspaceId === 'string' ? body.value.workspaceId : '',
      MAX_RECEIPT_ID_LENGTH,
    );

    sessionStore.destroy(sessionId(req, security.secure));
    const session = sessionStore.create({ workspaceId: requestedWorkspaceId || 'default' });
    writeJson(res, 200, { ok: true, expiresAt: session.expiresAt, workspaceId: session.workspaceId }, {
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

    const requestedWorkspaceId = sanitizeInput(reqUrl.searchParams.get('workspaceId') || '', MAX_RECEIPT_ID_LENGTH);
    if (requestedWorkspaceId && requestedWorkspaceId !== validation.workspaceId) {
      fail(res, 403, 'cross_workspace', 'workspaceId does not match the authenticated session');
      return;
    }
    const workspaceId = requestedWorkspaceId || validation.workspaceId;
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
    const asset = STATIC_ASSETS.get(pathname);
    if (asset) {
      if (reqUrl.search) {
        fail(res, 404, 'not_found', 'Viewer route not found');
        return undefined;
      }
      if (req.method !== 'GET') {
        fail(res, 405, 'method_not_allowed', 'Method not allowed', { Allow: 'GET' });
        return undefined;
      }
      writeAsset(res, asset);
      return undefined;
    }

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
