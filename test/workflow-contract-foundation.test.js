'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WORKFLOW_CAPABILITIES,
  WORKFLOW_STATUSES,
  COMPATIBILITY_COMMANDS,
  compatibilityHelpText,
  publicWorkflowManifest,
} = require('../lib/workflow-contract');
const { workflowEnvelope, unavailableWorkflowEnvelope } = require('../lib/http/workflow-envelope');
const { PUBLIC_ROUTES } = require('../lib/http/route-auth-policy');

test('workflow manifest uses unique versioned ids and explicitly declares every surface', () => {
  assert.equal(new Set(WORKFLOW_CAPABILITIES.map(item => item.workflowId)).size, WORKFLOW_CAPABILITIES.length);
  for (const item of WORKFLOW_CAPABILITIES) {
    assert.match(item.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(item.availability).sort(), ['api', 'cli', 'mcp', 'ui']);
    assert.equal(typeof item.authRequired, 'boolean');
    assert.equal(typeof item.workspaceRequired, 'boolean');
    if (item.mcpTool) {
      assert.ok(item.requestSchema, `${item.workflowId} reuses its MCP request schema`);
      assert.ok(item.responseSchema, `${item.workflowId} reuses its MCP response schema`);
    }
  }
});

test('compatibility help is generated only from the compatibility command contract', () => {
  const help = compatibilityHelpText();
  for (const item of COMPATIBILITY_COMMANDS) assert.match(help, new RegExp(`"${item.command}"`));
  for (const unsupported of ['backup', 'restore', 'yukle', 'ajan:', 'plan:']) {
    assert.doesNotMatch(help, new RegExp(unsupported));
  }
});

test('public manifest is detached and its endpoint is explicitly public read-only', () => {
  const manifest = publicWorkflowManifest();
  const originalAvailability = WORKFLOW_CAPABILITIES[0].availability.api;
  manifest.workflows[0].availability.api = !originalAvailability;
  assert.equal(WORKFLOW_CAPABILITIES[0].availability.api, originalAvailability);
  const route = PUBLIC_ROUTES.find(item => item.id === 'workflow-capabilities');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.match.pathname, '/api/v2/workflows');
});

test('workflow envelope has stable statuses and fail-closed unsupported error', () => {
  const completed = workflowEnvelope({ ok: true, status: 'completed', data: { answer: 42 } });
  assert.equal(completed.status, 'completed');
  assert.match(completed.traceId, /^[0-9a-f-]{36}$/);
  assert.equal(completed.error, null);
  assert.ok(WORKFLOW_STATUSES.includes(completed.status));

  const unsupported = unavailableWorkflowEnvelope('trace-fixed');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, 'capability_not_available');
  assert.equal(unsupported.error.code, 'UNSUPPORTED_WORKFLOW');
  assert.equal(unsupported.traceId, 'trace-fixed');
});
