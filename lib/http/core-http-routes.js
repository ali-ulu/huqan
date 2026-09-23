const { evaluateLlmSor, llmSorCheckFields } = require('../shield');
const {
  toPublicVerifyPayload,
  toPublicVerifyEnvelope,
} = require('../verify-status-vocabulary');
const { bindHttpProvenance } = require('./http-provenance');
const { buildUploadResponse } = require('./upload-admission-contract');
const { writeStructuredLog } = require('./structured-log');
const {
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_MAX_JSON_BODY,
  sanitizeInput,
} = require('../../requestGuards');

function createCoreHttpRoutes({
  kernel,
  getGraphData,
  getV2StatusData,
  getHealthData,
  handleAnswerRoute,
  parseJsonRequest,
  denyIfUnauthorized,
  buildCorsHeaders,
  writeJson,
  writeApiError,
  legacyVerify,
  JSON_CONTENT_TYPE,
}) {
  return async function handleCoreHttpRoutes(req, res, reqUrl, correlation) {
    if (reqUrl.pathname === '/graph-data') {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return true;
      }
      const rawWorkspaceId = reqUrl.searchParams.get('workspaceId') || '';
      const requestedWorkspaceId = sanitizeInput(rawWorkspaceId);
      const isDefaultScope = !requestedWorkspaceId || requestedWorkspaceId === 'default';
      if (!isDefaultScope && !denyIfUnauthorized(req, res)) return true;
      const workspaceId = requestedWorkspaceId || 'default';
      try {
        const data = getGraphData(workspaceId);
        res.writeHead(200, {
          'Content-Type': JSON_CONTENT_TYPE,
          ...buildCorsHeaders(req),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(data));
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.graph_data_error', correlation, {
          route: '/graph-data',
          method: req.method,
          errorCode: err?.code || 'GRAPH_DATA_FAILED',
        });
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
      return true;
    }

    if (reqUrl.pathname === '/v2-status') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      try {
        const data = getV2StatusData();
        res.writeHead(200, {
          'Content-Type': JSON_CONTENT_TYPE,
          ...buildCorsHeaders(req),
          'Cache-Control': 'no-cache',
        });
        res.end(JSON.stringify(data));
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.v2_status_error', correlation, {
          route: '/v2-status',
          method: req.method,
          errorCode: err?.code || 'V2_STATUS_FAILED',
        });
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
      return true;
    }

    if (reqUrl.pathname === '/health') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      try {
        res.writeHead(200, {
          'Content-Type': JSON_CONTENT_TYPE,
          ...buildCorsHeaders(req),
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(getHealthData()));
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.health_error', correlation, {
          route: '/health',
          method: req.method,
          errorCode: err?.code || 'HEALTH_FAILED',
        });
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
      return true;
    }

    if (reqUrl.pathname === '/v2/verify') {
      if (req.method !== 'POST') {
        writeJson(req, res, 405, { error: 'Method not allowed' });
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      const data = await parseJsonRequest(req, res, { maxBytes: 4_096 });
      if (!data) return true;
      const text = sanitizeInput(data.claim || data.statement || data.text || '');
      if (!text) {
        writeJson(req, res, 400, { error: 'claim, statement or text is required' });
        return true;
      }
      try {
        const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
        const result = kernel.verify(text, workspaceId ? { workspaceId } : {});
        writeJson(req, res, 200, toPublicVerifyEnvelope(result), { 'Cache-Control': 'no-cache' });
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.v2_verify_error', correlation, {
          route: '/v2/verify',
          method: req.method,
          errorCode: err?.code || 'V2_VERIFY_FAILED',
        });
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
      return true;
    }

    if (reqUrl.pathname === '/answer') {
      handleAnswerRoute(req, res, reqUrl);
      return true;
    }

    if (reqUrl.pathname === '/llm-sor') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_JSON_BODY });
      if (!data) return true;
      const question = sanitizeInput(data.question || data.q || '');
      const autoLearn = data.autoLearn === true;
      const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
      if (!question) {
        res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'question is required' }));
        return true;
      }

      try {
        const huqanCheck = legacyVerify(kernel.verify(question, workspaceId ? { workspaceId } : {}));
        const LLMAdapter = require('../../llmAdapter');
        const llm = new LLMAdapter();
        const llmRes = await llm.ask(question);

        if (!llmRes.ok) {
          res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
          res.end(JSON.stringify({
            ok: false,
            error: llmRes.error,
            ...llmSorCheckFields(huqanCheck),
          }));
          return true;
        }

        const llmText = llmRes.data.text;
        const llmCheck = legacyVerify(kernel.verify(
          llmText.slice(0, 300),
          workspaceId ? { workspaceId } : {},
        ));
        const shield = evaluateLlmSor({
          kernel,
          question,
          llmText,
          huqanCheck,
          llmCheck,
          autoLearn,
          maxSentences: 15,
          workspaceId,
        });

        res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({
          ok: true,
          question,
          llmAnswer: llmText,
          model: llmRes.data.model,
          ...llmSorCheckFields(huqanCheck),
          llmCheck: toPublicVerifyPayload(shield.llmCheck),
          label: shield.label,
          shield: shield.shield,
          learnResult: shield.learnResult,
        }));
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.llm_sor_error', correlation, {
          route: '/llm-sor',
          method: req.method,
          errorCode: err?.code || 'LLM_SOR_FAILED',
        });
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
      return true;
    }

    if (reqUrl.pathname === '/dogrula' || reqUrl.pathname === '/verify') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_JSON_BODY });
      if (!data) return true;
      const text = sanitizeInput(data.claim || data.statement || data.text || '');
      const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
      if (!text) {
        res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'claim, statement or text is required' }));
        return true;
      }
      try {
        const result = legacyVerify(kernel.verify(text, workspaceId ? { workspaceId } : {}));
        res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify(result));
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.verify_error', correlation, {
          route: '/dogrula',
          method: req.method,
          errorCode: err?.code || 'VERIFY_FAILED',
        });
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
      return true;
    }

    if (reqUrl.pathname === '/yukle' || reqUrl.pathname === '/upload') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      if (!denyIfUnauthorized(req, res)) return true;
      const contentLength = Number(req.headers['content-length'] || 0);
      if (Number.isFinite(contentLength) && contentLength > DEFAULT_MAX_UPLOAD_BODY) {
        res.writeHead(413, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'Payload too large (max 1MB)' }));
        return true;
      }
      const data = await parseJsonRequest(req, res, { maxBytes: DEFAULT_MAX_UPLOAD_BODY });
      if (!data) return true;
      const text = data.text || data.content || '';
      if (!text) {
        res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify({ error: 'text or content is required' }));
        return true;
      }
      const workspaceId = sanitizeInput(data.workspaceId || reqUrl.searchParams.get('workspaceId') || '');
      const suppliedActors = [data.actor, data.provenance?.actor]
        .map(actor => sanitizeInput(actor || ''))
        .filter(Boolean);
      if (suppliedActors.some(actor => actor !== 'http-api')) {
        writeApiError(
          req,
          res,
          400,
          'ACTOR_MISMATCH',
          'actor is derived from the authenticated HTTP boundary.',
        );
        return true;
      }
      try {
        const learnResult = kernel.learnDocument(text, {
          returnDetails: true,
          workspaceId,
          approvalRequired: true,
          provenance: bindHttpProvenance(data.provenance, {
            actor: 'http-api',
            workspaceId,
            sourceType: sanitizeInput(data.sourceType || '') || 'upload',
            sourceRef: sanitizeInput(data.sourceRef || '') || reqUrl.pathname,
            sourceTitle: sanitizeInput(data.sourceTitle || '') || 'HTTP upload',
          }),
        });
        const rawAdmission = Array.isArray(learnResult.admissions)
          ? (learnResult.admissions.find(Boolean) || null)
          : null;
        res.writeHead(200, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
        res.end(JSON.stringify(buildUploadResponse(learnResult.learned, rawAdmission)));
      } catch (err) {
        writeStructuredLog(console, 'error', 'http.upload_error', correlation, {
          route: '/yukle',
          method: req.method,
          errorCode: err?.code || 'UPLOAD_FAILED',
        });
        writeJson(req, res, 500, { error: 'Internal server error' });
      }
      return true;
    }

    return false;
  };
}

module.exports = { createCoreHttpRoutes };
