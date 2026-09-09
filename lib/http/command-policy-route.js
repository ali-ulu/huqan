'use strict';

const crypto = require('node:crypto');
const { readJsonBody, sanitizeInput } = require('../../requestGuards');
const { createCommandPolicyEditor } = require('../command-policy-editor');
const { defaultExternalActionPolicyPath } = require('../external-action-command-policy');

const BASE = '/api/command-policy';
function createCommandPolicyBoundary({ environment = process.env } = {}) {
  const token = environment.HUQAN_POLICY_EDITOR_TOKEN;
  const enabled = typeof token === 'string' && token.length >= 32
    && token === sanitizeInput(token, 256)
    && token !== sanitizeInput(environment.HUQAN_API_KEY || '', 256)
    && token !== sanitizeInput(environment.AXIOM_API_KEY || '', 256);
  const editorFor = workspaceId => enabled
    ? createCommandPolicyEditor(defaultExternalActionPolicyPath(environment, workspaceId || 'default'))
    : null;
  function respond(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }
  return {
    authContext: { commandPolicyRouteEnabled: enabled },
    async route(req, res, url) {
      if (![BASE, `${BASE}/preview`].includes(url.pathname)) return false;
      if (!enabled) { respond(res, 404, { error: 'NOT_CONFIGURED' }); return true; }
      // Separate operator credential: possession of the agent API key cannot relax policy.
      const supplied = req.headers['x-huqan-policy-token'];
      const digest = value => crypto.createHash('sha256').update(value).digest();
      if (typeof supplied !== 'string' || !crypto.timingSafeEqual(digest(supplied), digest(token))) {
        respond(res, 403, { error: 'OPERATOR_REQUIRED' }); return true;
      }
      const origin = req.headers.origin;
      if (origin && origin !== `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`) {
        respond(res, 403, { error: 'ORIGIN_REFUSED' }); return true;
      }
      const method = req.method;
      if (!(url.pathname === BASE && ['GET', 'PUT'].includes(method))
          && !(url.pathname === `${BASE}/preview` && method === 'POST')) {
        respond(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true;
      }
      try {
        const workspaceId = new URLSearchParams(url.search || '').get('workspaceId') || 'default';
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workspaceId)) { respond(res, 400, { error: 'INVALID_WORKSPACE' }); return true; }
        const editor = editorFor(workspaceId);
        if (method === 'GET') respond(res, 200, editor.snapshot());
        else {
          const parsed = await readJsonBody(req, { maxBytes: 64 * 1024 });
          if (!parsed.ok) { respond(res, parsed.status, parsed.error); return true; }
          const body = parsed.data;
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            respond(res, 400, { error: 'INVALID_BODY' }); return true;
          }
          respond(res, 200, method === 'PUT' ? editor.save(body) : editor.preview(body));
        }
      } catch (error) {
        respond(res, error.status || 503, { error: error.status ? error.code : 'POLICY_UNAVAILABLE' });
      }
      return true;
    },
  };
}

module.exports = { createCommandPolicyBoundary };
