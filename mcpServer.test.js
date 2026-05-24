const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

let proc;
let rl;
let nextId = 1;
const pending = new Map();
let tempDir;

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }
    }, 3000).unref?.();
  });
}

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mcp-'));
  proc = spawn(process.execPath, ['mcpServer.js'], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AXIOM_MEMORY_PATH: path.join(tempDir, 'memory.json'),
      AXIOM_DB_PATH: path.join(tempDir, 'memory.db'),
    },
  });
  rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', line => {
    const msg = JSON.parse(line);
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });
  proc.stderr.resume();
});

after(async () => {
  for (const [, entry] of pending) entry.reject(new Error('Process closed before response'));
  pending.clear();
  rl?.close();
  if (proc && !proc.killed) {
    proc.kill();
    await new Promise(resolve => proc.once('exit', resolve));
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('MCP Server', () => {
  it('initializes and lists tools', async () => {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);

    const list = await request('tools/list', {});
    assert.ok(Array.isArray(list.result.tools));
    assert.ok(list.result.tools.some(t => t.name === 'axiom.learn'));
    assert.ok(list.result.tools.some(t => t.name === 'axiom.ask'));
    const verifyTool = list.result.tools.find(t => t.name === 'axiom.verify');
    assert.ok(verifyTool);
    assert.ok(verifyTool.outputSchema);
    assert.deepStrictEqual(
      verifyTool.outputSchema.properties.data.anyOf[1].properties.status.enum,
      ['dogrulandi', 'celiski', 'bilinmiyor']
    );
  });

  it('can learn and ask through tools/call', async () => {
    const learn = await request('tools/call', {
      name: 'axiom.learn',
      arguments: { text: 'kedi hayvandir' },
    });
    assert.strictEqual(learn.result.isError, false);
    assert.strictEqual(learn.result.structuredContent.ok, true);

    const ask = await request('tools/call', {
      name: 'axiom.ask',
      arguments: { question: 'kedi nedir' },
    });
    assert.strictEqual(ask.result.isError, false);
    assert.strictEqual(ask.result.structuredContent.ok, true);
    assert.ok(ask.result.structuredContent.data.answer);
    assert.ok(Array.isArray(ask.result.content));
  });
});
