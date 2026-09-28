'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const HuqanStorage = require('../storage');
const { resolveExperienceJournal } = require('../agentRuntime');
const { buildExperienceRead } = require('../lib/experience/read-model');
const { createCliCommandHandlers } = require('../lib/cli-command-handlers');
const { createReadWorkflowHttpRouter, NO_CAPABILITY_ENSURE } = require('../lib/http/read-workflow-actions');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const { callTool, TOOL_SCHEMAS } = require('../mcpServer');

function seed(journal) {
  assert.equal(journal.append({
    runId: 'run-production-read',
    workspaceId: 'workspace-a',
    eventId: 'event-start',
    type: 'run_started',
  }).ok, true);
  assert.equal(journal.append({
    runId: 'run-production-read',
    workspaceId: 'workspace-a',
    eventId: 'event-finished',
    type: 'execution_finished',
    executionStatus: 'completed',
  }).ok, true);
  assert.equal(journal.append({
    runId: 'run-production-read',
    workspaceId: 'workspace-a',
    eventId: 'event-verified',
    type: 'verification',
    verdict: 'verified',
    proofs: { integrity: true, coverage: true, verification: true, provenance: true, permission: true },
  }).ok, true);
}

test('Experience read is production-reachable through CLI, MCP and authenticated HTTP with one projection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-read-wiring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => storage.close());

  const journal = resolveExperienceJournal({ kernel }, storage);
  assert.ok(journal, 'production Experience journal must be available');
  assert.equal(kernel.experienceJournal, journal);
  seed(journal);

  const direct = buildExperienceRead(journal, {
    runId: 'run-production-read',
    workspaceId: 'workspace-a',
  });
  assert.equal(direct.ok, true);

  const cliHandlers = createCliCommandHandlers({
    callMcpTool() { throw new Error('not used by experience-read'); },
    createApprovalStoreFromKernel() { return null; },
  });
  const cliText = cliHandlers['experience-read']({
    kernel,
  }, {
    runId: 'run-production-read',
    workspaceId: 'workspace-a',
  });
  assert.match(cliText, new RegExp(direct.hash, 'u'));

  const mcp = callTool(kernel, {
    name: 'huqan.experience_read',
    arguments: { runId: 'run-production-read', workspaceId: 'workspace-a' },
  });
  assert.equal(mcp.ok, true);
  assert.equal(mcp.data.hash, direct.hash);
  assert.deepEqual(mcp.data.manifest, direct.manifest);

  let httpStatus = null;
  let httpBody = null;
  const http = createReadWorkflowHttpRouter({
    kernel,
    parseJsonRequest: async () => ({}),
    writeJson: (_req, _res, status, body) => { httpStatus = status; httpBody = body; },
    writeApiError() { throw new Error('not used by Experience GET'); },
    ensureCapabilities: NO_CAPABILITY_ENSURE,
  });
  const handled = await http(
    { method: 'GET' },
    {},
    new URL('http://local/api/experience/read?runId=run-production-read&workspaceId=workspace-a'),
  );
  assert.equal(handled, true);
  assert.equal(httpStatus, 200);
  assert.equal(httpBody.hash, direct.hash);
  assert.deepEqual(httpBody.manifest, direct.manifest);

  const auth = resolveRouteAuthPolicy('/api/experience/read', 'GET');
  assert.equal(auth.known, true);
  assert.equal(auth.authRequired, true);
  assert.equal(auth.ruleId, 'experience-read');

  assert.ok(TOOL_SCHEMAS.some((tool) => tool.name === 'huqan.experience_read'));
});

test('Experience read production surfaces keep workspace mismatch fail-closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-read-scope-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  try {
    const journal = resolveExperienceJournal({ kernel }, storage);
    seed(journal);

    const mcp = callTool(kernel, {
      name: 'huqan.experience_read',
      arguments: { runId: 'run-production-read', workspaceId: 'workspace-b' },
    });
    assert.equal(mcp.ok, false);
    assert.equal(mcp.error.code, 'EXPERIENCE_READ_FAILED');
    assert.match(mcp.error.message, /workspace_mismatch/u);

    let status = null;
    let body = null;
    const http = createReadWorkflowHttpRouter({
      kernel,
      parseJsonRequest: async () => ({}),
      writeJson: (_req, _res, code, payload) => { status = code; body = payload; },
      writeApiError() { throw new Error('not used'); },
      ensureCapabilities: NO_CAPABILITY_ENSURE,
    });
    await http(
      { method: 'GET' },
      {},
      new URL('http://local/api/experience/read?runId=run-production-read&workspaceId=workspace-b'),
    );
    assert.equal(status, 403);
    assert.equal(body.code, 'workspace_mismatch');
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP and MCP process entrypoints attach the shared production Experience journal', () => {
  const root = path.join(__dirname, '..');
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const mcpSource = fs.readFileSync(path.join(root, 'mcpServer.js'), 'utf8');

  assert.match(serverSource, /resolveExperienceJournal,/);
  assert.match(serverSource, /createServerRouteRuntime\(\{/);
  assert.match(mcpSource, /resolveExperienceJournal\(\{/);
  assert.match(mcpSource, /\}, approvalStore\)/);
});
