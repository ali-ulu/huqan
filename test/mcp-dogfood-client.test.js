const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function createRpcClient() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mcp-dogfood-'));
  const memoryPath = path.join(tempDir, 'memory.json');
  const dbPath = path.join(tempDir, 'memory.db');
  const stderr = [];
  let nextId = 1;
  const pending = new Map();

  const KernelV2 = require('../kernel.v2');
  const seedKernel = new KernelV2({ memoryPath, dbPath, loadPlugins: false });
  seedKernel.learn('kedi hayvandir');
  const seedGraph = seedKernel.kernel && seedKernel.kernel.graph;
  if (seedGraph && typeof seedGraph.close === 'function') seedGraph.close();

  const proc = spawn(process.execPath, ['mcpServer.js'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AXIOM_MEMORY_PATH: memoryPath,
      AXIOM_DB_PATH: dbPath,
      AXIOM_KERNEL_VERSION: 'v2',
    },
  });

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
      return;
    }
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });

  proc.stderr.on('data', chunk => stderr.push(String(chunk)));
  proc.once('exit', code => {
    const err = new Error(`MCP process exited with code ${code}; stderr=${stderr.join('')}`);
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });

  function request(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout waiting for ${method}; stderr=${stderr.join('')}`));
        }
      }, 5000);
      timer.unref?.();
      pending.set(id, {
        resolve: msg => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  async function close() {
    for (const entry of pending.values()) entry.reject(new Error('MCP client closing'));
    pending.clear();
    rl.close();
    if (proc.exitCode === null && !proc.killed) {
      proc.kill();
      await new Promise(resolve => proc.once('exit', resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { request, close, tempDir };
}

function structured(msg) {
  assert.ok(msg.result, JSON.stringify(msg));
  assert.ok(msg.result.structuredContent, JSON.stringify(msg.result));
  return msg.result.structuredContent;
}

function removeRepoRootArtifacts() {
  for (const filename of ['memory.json', 'memory.db', 'agent.memory.json']) {
    fs.rmSync(path.join(repoRoot, filename), { force: true });
  }
}

test('real stdio MCP client exercises allowed and gated tool contracts', async () => {
  removeRepoRootArtifacts();
  const client = createRpcClient();
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dogfood-client', version: '1.0.0' },
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const listed = await client.request('tools/list', {});
    const toolNames = listed.result.tools.map(tool => tool.name);
    assert.ok(toolNames.includes('axiom.ask'));
    assert.ok(toolNames.includes('axiom.verify'));
    assert.ok(toolNames.includes('axiom.learn'));
    assert.ok(toolNames.includes('axiom.agent'));

    const ask = await client.request('tools/call', {
      name: 'axiom.ask',
      arguments: { question: 'kedi nedir' },
    });
    assert.equal(ask.result.isError, false);
    assert.equal(structured(ask).ok, true);
    assert.equal(structured(ask).type, 'ask');

    const verify = await client.request('tools/call', {
      name: 'axiom.verify',
      arguments: { statement: 'kedi hayvandir' },
    });
    assert.equal(verify.result.isError, false);
    assert.equal(structured(verify).ok, true);
    assert.equal(structured(verify).type, 'verify');
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(structured(verify).data.status));
    assert.equal(structured(verify).data.status, 'dogrulandi');

    const learn = await client.request('tools/call', {
      name: 'axiom.learn',
      arguments: { text: 'dogfoodalpha dogfoodbeta' },
    });
    const learnBody = structured(learn);
    assert.equal(learn.result.isError, true);
    assert.equal(learnBody.ok, false);
    assert.equal(learnBody.type, 'learn');
    assert.equal(learnBody.meta.gate, 'review');
    assert.equal(learnBody.data.decision, 'review');
    assert.equal(learnBody.error.code, 'MUTATING_REQUIRES_REVIEW');

    const notMutated = await client.request('tools/call', {
      name: 'axiom.verify',
      arguments: { statement: 'dogfoodalpha dogfoodbeta' },
    });
    assert.notEqual(structured(notMutated).data.status, 'dogrulandi');

    const agent = await client.request('tools/call', {
      name: 'axiom.agent',
      arguments: { goal: 'learn dogfoodalpha dogfoodbeta' },
    });
    const agentBody = structured(agent);
    assert.equal(agent.result.isError, true);
    assert.equal(agentBody.ok, false);
    assert.equal(agentBody.type, 'agent');
    assert.equal(agentBody.meta.gate, 'dry_run_only');
    assert.equal(agentBody.data.decision, 'dry_run_only');
    assert.equal(agentBody.error.code, 'AGENT_LOOP_DRY_RUN_ONLY');

    const unknown = await client.request('tools/call', {
      name: 'axiom.unknown',
      arguments: { statement: 'kedi hayvandir' },
    });
    const unknownBody = structured(unknown);
    assert.equal(unknown.result.isError, true);
    assert.equal(unknownBody.ok, false);
    assert.equal(unknownBody.meta.gate, 'block');
    assert.equal(unknownBody.data.decision, 'block');
    assert.equal(unknownBody.error.code, 'UNKNOWN_TOOL_BLOCKED');

    const nullParams = await client.request('tools/call', null);
    const nullBody = structured(nullParams);
    assert.equal(nullParams.result.isError, true);
    assert.equal(nullBody.ok, false);
    assert.equal(nullBody.meta.gate, 'block');
    assert.equal(nullBody.error.code, 'UNKNOWN_TOOL_BLOCKED');

    const approvals = await client.request('tools/call', {
      name: 'axiom.approvals',
      arguments: { limit: 10 },
    });
    assert.equal(approvals.result.isError, false);
    assert.equal(structured(approvals).pendingCount, 0);

    const ping = await client.request('ping', {});
    assert.deepEqual(ping.result, {});
  } finally {
    await client.close();
  }

  for (const filename of ['memory.json', 'memory.db', 'agent.memory.json']) {
    assert.equal(fs.existsSync(path.join(repoRoot, filename)), false, `${filename} leaked into repo root`);
  }
});
