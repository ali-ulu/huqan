'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');

const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'mcpServer.js');
const { createMcpOperatorCapability, operatorCapabilityBinding } = require('../mcpServer');
const { canonicalMcpToolName } = require('../lib/mcp-tool-names');

function createDogfoodClient(envOverrides = {}) {
  const proc = cp.spawn(process.execPath, [MCP_SERVER_PATH], {
    env: { HUQAN_MCP_OPERATOR_TOKEN: 'test-operator', ...process.env, ...envOverrides },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  proc.stdin.setDefaultEncoding('utf8');
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  const pending = new Map();
  const stderrChunks = [];
  const exitPromise = once(proc, 'exit');
  let nextId = 1;

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (message && message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      entry.resolve(message);
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);
  });

  proc.on('exit', (code, signal) => {
    for (const entry of pending.values()) {
      entry.reject(new Error(`MCP server exited before responding (code=${code}, signal=${signal || 'null'})`));
    }
    pending.clear();
  });

  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 10000);

      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      const canonicalName = canonicalMcpToolName(params?.name);
      const requestParams = method === 'tools/call' && ['huqan.approvals', 'huqan.approve', 'huqan.agent_resume'].includes(canonicalName)
        ? {
            ...params,
            operatorCapability: createMcpOperatorCapability({
              secret: 'test-operator',
              ...operatorCapabilityBinding(canonicalName, params.arguments || {}),
            }),
          }
        : params;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: requestParams })}\n`);
    });
  }

  async function close() {
    try {
      await request('shutdown', {});
    } catch {
      // Ignore shutdown races during teardown.
    }
    await exitPromise;
    rl.close();
  }

  return {
    request,
    close,
    stderr() {
      return stderrChunks.join('');
    },
  };
}

function parseToolCallResponse(response) {
  assert.ok(response);
  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result);
  return response.result;
}

async function callTool(client, name, args = {}) {
  return parseToolCallResponse(await client.request('tools/call', {
    name,
    arguments: args,
  }));
}

test('MCP dogfood client harness exercises allow, durable review and block decisions through stdio', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-dogfood-'));
  const client = createDogfoodClient({
    AXIOM_DB_PATH: path.join(tempDir, 'memory.db'),
    AXIOM_MEMORY_PATH: path.join(tempDir, 'memory.json'),
  });
  try {
    const init = await client.request('initialize', {});
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.result.serverInfo.name, 'huqan');

    // tools/list advertises canonical names only (RFC-001 writer rule). Every
    // tools/call below still uses the legacy `axiom.*` spelling on purpose:
    // that is what proves the aliases stay callable after they stop being
    // advertised.
    const toolsList = await client.request('tools/list', {});
    assert.ok(Array.isArray(toolsList.result.tools));
    assert.ok(toolsList.result.tools.some((tool) => tool.name === 'huqan.learn'));
    assert.ok(toolsList.result.tools.some((tool) => tool.name === 'huqan.agent'));
    assert.ok(!toolsList.result.tools.some((tool) => tool.name.startsWith('axiom.')));

    const askResp = parseToolCallResponse(await client.request('tools/call', {
      name: 'axiom.ask',
      arguments: { question: 'kedi nedir?' },
    }));
    assert.equal(askResp.isError, false);
    assert.equal(askResp.structuredContent.ok, true);
    assert.equal(typeof askResp.structuredContent.data.answer, 'string');
    assert.ok(askResp.structuredContent.data.answer.length > 0);

    const verifyResp = parseToolCallResponse(await client.request('tools/call', {
      name: 'axiom.verify',
      arguments: { statement: 'kedi hayvandir' },
    }));
    assert.equal(verifyResp.isError, false);
    assert.equal(verifyResp.structuredContent.ok, true);
    assert.equal(typeof verifyResp.structuredContent.data.status, 'string');
    assert.ok(['verified', 'contradicted', 'unknown'].includes(verifyResp.structuredContent.data.status));

    const approvalsBefore = parseToolCallResponse(await client.request('tools/call', {
      name: 'axiom.approvals',
      arguments: {},
    }));
    const pendingBefore = approvalsBefore.structuredContent.pendingCount;

    const learnResp = parseToolCallResponse(await client.request('tools/call', {
      name: 'axiom.learn',
      arguments: { text: 'dogfood harness sentinel fact' },
    }));
    assert.equal(learnResp.isError, true);
    const learnPayload = JSON.parse(learnResp.content[0].text);
    assert.equal(learnPayload.ok, false);
    assert.equal(learnPayload.gate.decision, 'review');
    assert.equal(learnPayload.gate.allowed, false);
    assert.equal(learnPayload.gate.canExecute, false);
    assert.equal(learnPayload.gate.requiredReview, true);

    const agentResp = parseToolCallResponse(await client.request('tools/call', {
      name: 'axiom.agent',
      arguments: { goal: 'run an autonomous loop' },
    }));
    assert.equal(agentResp.isError, true);
    assert.equal(agentResp.structuredContent.ok, false);
    const agentPayload = agentResp.structuredContent;
    assert.equal(agentPayload.gate.decision, 'review');
    assert.equal(agentPayload.gate.reason, 'agent_loop_requires_review');
    assert.equal(agentPayload.gate.allowed, false);
    assert.equal(agentPayload.gate.canExecute, false);
    assert.equal(agentPayload.gate.canDryRun, true);
    assert.equal(agentPayload.approval.persisted, true);
    assert.ok(agentPayload.approval.id);

    const unknownResp = parseToolCallResponse(await client.request('tools/call', {
      name: 'axiom.unknown_tool',
      arguments: {},
    }));
    assert.equal(unknownResp.isError, true);
    const unknownPayload = JSON.parse(unknownResp.content[0].text);
    assert.equal(unknownPayload.ok, false);
    assert.equal(unknownPayload.gate.decision, 'block');
    assert.equal(unknownPayload.gate.allowed, false);
    assert.equal(unknownPayload.gate.canExecute, false);
    assert.equal(unknownPayload.gate.reason, 'unknown_tool_blocked');

    const approvalsAfter = parseToolCallResponse(await client.request('tools/call', {
      name: 'axiom.approvals',
      arguments: {},
    }));
    assert.equal(approvalsAfter.structuredContent.pendingCount, pendingBefore + 2);
    assert.equal(approvalsAfter.structuredContent.approvals.length, approvalsBefore.structuredContent.approvals.length + 2);
  } finally {
    await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('MCP dogfood client persists approval, receipt, and idempotent replay across restarts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-approval-dogfood-'));
  const env = {
    AXIOM_DB_PATH: path.join(tempDir, 'memory.db'),
    AXIOM_MEMORY_PATH: path.join(tempDir, 'memory.json'),
  };
  const text = 'mcp dogfood approval restart replay sentinel hayvandir';
  let client;

  try {
    client = createDogfoodClient(env);
    assert.ok((await client.request('initialize', {})).result);
    const queued = await callTool(client, 'axiom.learn', { text });
    assert.equal(queued.isError, true);
    const queuedPayload = JSON.parse(queued.content[0].text);
    assert.equal(queuedPayload.gate.decision, 'review');
    assert.equal(queuedPayload.approval.status, 'pending');
    const approvalId = queuedPayload.approval.id;
    await client.close();

    client = createDogfoodClient(env);
    assert.ok((await client.request('initialize', {})).result);
    const afterRestart = await callTool(client, 'axiom.approvals', { limit: 20 });
    assert.ok(
      afterRestart.structuredContent.approvals.some((approval) => approval.id === approvalId && approval.status === 'pending'),
      'a pending approval must be visible to a new MCP server process'
    );

    const approved = await callTool(client, 'axiom.approve', {
      approvalId,
      workspaceId: 'default',
      decision: 'approved',
      reason: 'dogfood approval',
    });
    assert.equal(approved.isError, false);
    assert.equal(approved.structuredContent.ok, true);
    assert.equal(approved.structuredContent.data.executed, true);
    assert.equal(approved.structuredContent.data.idempotent, false);
    assert.equal(approved.structuredContent.data.approval.status, 'approved');
    assert.ok(approved.structuredContent.data.result.meta.committedReceiptId);
    assert.ok(approved.structuredContent.data.result.meta.committedReceiptHash);
    await client.close();

    client = createDogfoodClient(env);
    assert.ok((await client.request('initialize', {})).result);
    const persisted = await callTool(client, 'axiom.verify', { statement: text });
    assert.equal(persisted.isError, false);
    assert.equal(persisted.structuredContent.data.status, 'verified');
    const replay = await callTool(client, 'axiom.approve', {
      approvalId,
      workspaceId: 'default',
      decision: 'approved',
      reason: 'dogfood replay must not re-execute',
    });
    assert.equal(replay.isError, false);
    assert.equal(replay.structuredContent.ok, true);
    assert.equal(replay.structuredContent.data.executed, false);
    assert.equal(replay.structuredContent.data.idempotent, true);
  } finally {
    if (client) await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
