'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = require('../cli');
const Kernel = require('../kernel');
const { createAxiomClient } = require('../lib/sdk');
const { createServer } = require('../mcpServer');

function createFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-4b1-${label}-`));
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  return { root, kernel };
}

function closeFixture(fixture, server) {
  try { server?.approvalStore?.close?.(); } catch (_) {}
  try { fixture.kernel?.graph?.close?.(); } catch (_) {}
  try { fixture.kernel?.memory?.close?.(); } catch (_) {}
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function callTool(server, name, args = {}) {
  const response = server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  assert.ok(response.result?.structuredContent, `${name} must return structured content`);
  return response.result.structuredContent;
}

function cliVerifyStatus(cli, statement) {
  const output = cli.execute('verify', statement);
  const match = /^Verify: ([^ ]+)/.exec(output);
  assert.ok(match, `unexpected CLI verify output: ${output}`);
  return match[1];
}

test('verify classification stays aligned across Kernel, CLI, and SDK wrappers', () => {
  const fixture = createFixture('verify');
  const cli = Object.create(CLI.prototype);
  cli.kernel = fixture.kernel;
  const sdk = createAxiomClient(fixture.kernel);
  try {
    fixture.kernel.learn('kedi hayvandir', {
      admissionRequired: false,
      admissionBypassReason: 'test_fixture',
    });
    fixture.kernel.learn('kus ucmaz', {
      admissionRequired: false,
      admissionBypassReason: 'test_fixture',
    });

    const cases = [
      ['kedi hayvandir', 'dogrulandi'],
      ['kus ucar', 'celiski'],
      ['balik ucabilir', 'bilinmiyor'],
    ];

    for (const [statement, expected] of cases) {
      const statuses = [
        fixture.kernel.verify(statement).data.status,
        cliVerifyStatus(cli, statement),
        sdk.verify(statement).data.status,
      ];
      assert.deepEqual(statuses, [expected, expected, expected]);
    }
  } finally {
    closeFixture(fixture);
  }
});

test('MCP learn strips caller bypass metadata and executes an approval once', () => {
  const fixture = createFixture('mcp-bypass');
  const mcp = createServer(fixture.kernel);
  const learnCalls = [];
  const originalLearn = fixture.kernel.learn.bind(fixture.kernel);
  fixture.kernel.learn = (text, options) => {
    learnCalls.push({ text, options });
    return originalLearn(text, options);
  };

  try {
    const queued = callTool(mcp, 'axiom.learn', {
      text: 'mcp bypass sentinel hayvandir',
      workspaceId: 'caller-workspace',
      admissionRequired: false,
      admissionBypassReason: 'caller-controlled',
      approvalStatus: 'approved',
      approvalId: 'caller-approval',
    });

    assert.equal(queued.ok, false);
    assert.equal(queued.gate.decision, 'review');
    assert.equal(learnCalls.length, 0);

    const approved = callTool(mcp, 'axiom.approve', {
      approvalId: queued.approval.id,
      decision: 'approved',
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.data.executed, true);
    assert.equal(learnCalls.length, 1);

    const options = learnCalls[0].options;
    assert.equal(options.workspaceId, 'default');
    assert.equal(options.approvalRequired, true);
    assert.equal(options.approvalStatus, 'approved');
    assert.equal(options.approvalId, queued.approval.id);
    assert.equal(Object.hasOwn(options, 'admissionRequired'), false);
    assert.equal(Object.hasOwn(options, 'admissionBypassReason'), false);
    assert.equal(options.provenance.workspaceId, 'default');

    const duplicate = callTool(mcp, 'axiom.approve', {
      approvalId: queued.approval.id,
      decision: 'approved',
    });
    assert.equal(duplicate.data.idempotent, true);
    assert.equal(duplicate.data.executed, false);
    assert.equal(learnCalls.length, 1);
  } finally {
    closeFixture(fixture, mcp);
  }
});
