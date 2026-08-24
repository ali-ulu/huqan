'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createReadWorkflowHttpRouter } = require('../lib/http/read-workflow-actions');
const { validateWorkflowHttpRequest } = require('../lib/http/workflow-request-validation');

test('published workflow schemas reject unsupported JSON shapes and preserve valid inputs', () => {
  assert.match(validateWorkflowHttpRequest('memory-search', {
    workspaceId: ['tenant-a'], query: 'cats',
  }), /workspaceId must be a string/);
  assert.match(validateWorkflowHttpRequest('memory-search', {
    workspaceId: 'tenant-a', query: 'cats', extra: true,
  }), /extra is not allowed/);
  assert.equal(validateWorkflowHttpRequest('memory-search', {
    workspaceId: 'tenant-a', query: 'cats',
  }), null);
});

test('read workflow routes validate the advertised body before downstream coercion', async () => {
  const writes = [];
  let graphRead = 0;
  const handler = createReadWorkflowHttpRouter({
    kernel: { graph: { getNodes: () => { graphRead += 1; return {}; } } },
    parseJsonRequest: async req => req.body,
    writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
    writeApiError: () => assert.fail('validation should use the workflow envelope'),
  });
  const handled = await handler({ method: 'POST', body: {
    workspaceId: ['tenant-a'], query: 'cats',
  } }, {}, new URL('http://localhost/api/v2/workflows/search'));

  assert.equal(handled, true);
  assert.equal(writes[0].status, 400);
  assert.equal(writes[0].json.error.code, 'INVALID_INPUT');
  assert.equal(writes[0].headers['Cache-Control'], 'no-store');
  assert.equal(graphRead, 0);
});
