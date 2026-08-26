'use strict';

// POST /answer — graph-grounded fluent answers without an external LLM
// (PR #1624). Kept out of server.js by the large-file ratchet (#328):
// server.js is over threshold and may not grow, so this surface owns a module.

function createAnswerRoute(deps) {
  const {
    kernel,
    legacyVerify,
    sanitizeInput,
    parseJsonRequest,
    denyIfUnauthorized,
    buildCorsHeaders,
    JSON_CONTENT_TYPE,
    DEFAULT_MAX_JSON_BODY,
    writeJson,
  } = deps;

  return async function handleAnswerRoute(req, res, reqUrl) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!denyIfUnauthorized(req, res)) return;
    const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_JSON_BODY });
    if (!data) return;
    const question = sanitizeInput(data.question || data.q || '');
    const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
    if (!question) {
      res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'question is required' }));
      return;
    }
    try {
      // Lazy require keeps startup graph identical when this surface is unused.
      const { composeFluentAnswer } = require('../fluent-answer');
      const verifyOpts = workspaceId ? { workspaceId } : {};
      const check = legacyVerify(kernel.verify(question, verifyOpts));
      const composed = composeFluentAnswer(check, question, { lang: data.lang });
      res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req), 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({
        ok: true,
        question,
        answer: composed.answer,
        status: composed.status,
        confidence: composed.confidence,
        evidenceCount: composed.evidenceCount,
        lang: composed.lang,
      }));
    } catch (err) {
      console.error('[answer]', err);
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
  };
}

module.exports = { createAnswerRoute };
