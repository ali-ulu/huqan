'use strict';

const { publicWorkflowManifest, workflowOpenApiDocument } = require('../workflow-contract');
const { unavailableWorkflowEnvelope } = require('./workflow-envelope');
const { writeApiError, writeJson } = require('../server-response-helpers');

function handleWorkflowContractRoute(req, res, reqUrl) {
  if (!['/api/v2/workflows', '/api/v2/openapi.json'].includes(reqUrl.pathname)) return false;
  if (req.method !== 'GET') {
    writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }
  writeJson(req, res, 200, reqUrl.pathname.endsWith('openapi.json') ? workflowOpenApiDocument() : publicWorkflowManifest(), {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return true;
}

function writeUnavailableWorkflow(req, res) {
  writeJson(req, res, 403, {
    ...unavailableWorkflowEnvelope(),
    result: 'Bu komut web API üzerinden çalıştırılamaz.',
  }, { 'X-Content-Type-Options': 'nosniff' });
}

module.exports = { handleWorkflowContractRoute, writeUnavailableWorkflow };
