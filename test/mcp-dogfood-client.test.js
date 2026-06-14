'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');

const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'mcpServer.js');

function createDogfoodClient() {
  const proc = cp.spawn(process.execPath, [MCP_SERVER_PATH], {
    env: { ...process.env },
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

      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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

test('MCP dogfood client harness exercises allow, review, dry-run and block decisions through stdio', async () => {
  const client = createDogfoodClient();
  try {
    const init = await client.request('initialize', {});
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.result.serverInfo.name, 'axiom');

    const toolsList = await client.request('tools/list', {});
    assert.ok(Array.isArray(toolsList.result.tools));
    assert.ok(toolsList.result.tools.some((tool) => tool.name === 'axiom.learn'));
    assert.ok(toolsList.result.tools.some((tool) => tool.name === 'axiom.agent'));

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
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(verifyResp.structuredContent.data.status));

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
    const agentPayload = JSON.parse(agentResp.content[0].text);
    assert.equal(agentPayload.ok, false);
    assert.equal(agentPayload.gate.decision, 'dry_run_only');
    assert.equal(agentPayload.gate.allowed, false);
    assert.equal(agentPayload.gate.canExecute, false);
    assert.equal(agentPayload.gate.canDryRun, true);

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
    assert.equal(approvalsAfter.structuredContent.pendingCount, pendingBefore);
    assert.equal(approvalsAfter.structuredContent.approvals.length, approvalsBefore.structuredContent.approvals.length);
  } finally {
    await client.close();
  }
});
