'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const SERVER = path.resolve(__dirname, '..', 'mcpServer.js');

// A statement no store can contain, so the verdict is `unknown` whatever graph
// the server opens. The subject under test is which *vocabulary* is spoken,
// and pinning the verdict to ambient store contents would make that assertion
// fail for a reason that has nothing to do with the vocabulary.
const NONCE_STATEMENT = `Zqx${Date.now()}${Math.random().toString(36).slice(2)} causes Wvy${Math.random().toString(36).slice(2)}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-vocab-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

// Each session gets its own store. Without this the assertions would depend on
// whatever the developer's default graph happens to contain, and the verdict
// would drift between a clean checkout and a used one.
let storeSeq = 0;
function freshStore() {
  storeSeq += 1;
  return path.join(tempDir, `store${storeSeq}.db`);
}

// Drive the real stdio server rather than the builder, because the claim under
// test is about what an MCP client observes: the advertised schema and the
// emitted payload naming the same vocabulary.
function mcpSession(env = {}) {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vocab-test', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'huqan.verify', arguments: { statement: NONCE_STATEMENT } } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';

  const stdout = execFileSync(process.execPath, [SERVER], {
    input: requests,
    encoding: 'utf8',
    env: { ...process.env, HUQAN_DB_PATH: freshStore(), ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 60000,
  });

  const messages = stdout.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch (_) {
      return null;
    }
  }).filter(Boolean);

  const list = messages.find((m) => m.id === 2);
  const call = messages.find((m) => m.id === 3);
  const verify = list.result.tools.find((t) => t.name === 'huqan.verify');

  return {
    advertised: findStatusEnum(verify.outputSchema),
    emitted: JSON.parse(call.result.content[0].text).data.status,
  };
}

// The data schema sits under an anyOf branch, so search for the enum rather
// than hardcoding a path this test would then have to be kept in step with.
function findStatusEnum(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.enum)
      && (node.enum.includes('verified') || node.enum.includes('dogrulandi'))) {
    return node.enum;
  }
  for (const key of Object.keys(node)) {
    const found = findStatusEnum(node[key]);
    if (found) return found;
  }
  return null;
}

test('MCP advertises and emits the canonical English verify vocabulary', () => {
  const { advertised, emitted } = mcpSession();

  assert.deepEqual(advertised, ['verified', 'contradicted', 'unknown']);
  assert.equal(emitted, 'unknown');
});

test('the legacy opt-in moves the schema and the payload together', () => {
  // The invariant that makes this a compatibility gate rather than a break: a
  // client that reads the schema it is given is correct in either mode.
  const { advertised, emitted } = mcpSession({ HUQAN_MCP_LEGACY_VERIFY_STATUS: '1' });

  assert.deepEqual(advertised, ['dogrulandi', 'celiski', 'bilinmiyor']);
  assert.equal(emitted, 'bilinmiyor');
  assert.ok(advertised.includes(emitted), 'emitted status must be in the advertised enum');
});

test('the legacy opt-in is also readable under its AXIOM_ name', () => {
  const { advertised } = mcpSession({ AXIOM_MCP_LEGACY_VERIFY_STATUS: '1' });

  assert.deepEqual(advertised, ['dogrulandi', 'celiski', 'bilinmiyor']);
});

test('an unset or unrecognised opt-in value means canonical', () => {
  const { advertised } = mcpSession({ HUQAN_MCP_LEGACY_VERIFY_STATUS: 'no' });

  assert.deepEqual(advertised, ['verified', 'contradicted', 'unknown']);
});

test('the emitted status is always inside the advertised enum', () => {
  const { advertised, emitted } = mcpSession();

  assert.ok(advertised.includes(emitted));
});
