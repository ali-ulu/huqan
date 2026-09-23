const { parseCommand } = require('../command-parser');
const {
  isAllowedPublicCommand,
  commandRequiresAuthentication,
  isUnsafePublicApiCommand,
  sanitizeInput,
} = require('../../requestGuards');
const { runPublicApiCommand } = require('./public-api-commands');
const { writeUnavailableWorkflow } = require('./workflow-contract-route');
const { writeStructuredLog } = require('./structured-log');

function createPublicApiRoute({
  kernel,
  denyIfUnauthorized,
  buildCorsHeaders,
  writeJson,
  JSON_CONTENT_TYPE,
}) {
  return async function handlePublicApiRoute(req, res, reqUrl, correlation) {
    if (reqUrl.pathname !== '/api') return false;
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }
    const raw = reqUrl.searchParams.get('q') || '';
    const q = sanitizeInput(raw);
    if (!q) {
      res.writeHead(400, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ result: 'HATA: Boş girdi.' }));
      return true;
    }
    if (isUnsafePublicApiCommand(q)) {
      writeUnavailableWorkflow(req, res);
      return true;
    }
    try {
      const parsed = parseCommand(q, kernel);
      if (parsed && (
        !isAllowedPublicCommand(parsed.command)
        || isUnsafePublicApiCommand(parsed.command)
      )) {
        writeUnavailableWorkflow(req, res);
        return true;
      }
      if (parsed
          && commandRequiresAuthentication(parsed.command)
          && !denyIfUnauthorized(req, res)) return true;
      let result;
      if (!parsed) {
        result = 'HATA: Anlamadım.';
      } else {
        result = runPublicApiCommand(parsed.command, parsed.args, kernel);
        if (result === null) {
          writeUnavailableWorkflow(req, res);
          return true;
        }
      }
      res.writeHead(200, {
        'Content-Type': JSON_CONTENT_TYPE,
        ...buildCorsHeaders(req),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify({ result }));
    } catch (err) {
      writeStructuredLog(console, 'error', 'http.api_error', correlation, {
        route: '/api',
        method: req.method,
        errorCode: err?.code || 'API_FAILED',
      });
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
    return true;
  };
}

module.exports = { createPublicApiRoute };
