'use strict';

/**
 * A2 — a misconfiguration and a crash used to be the same answer.
 *
 * `tools/call` catches everything and answers `INTERNAL_ERROR (ref: …)`, which
 * is right for a fault (#413: an unexpected `err.message` carries paths,
 * driver codes and internal identifiers, and an MCP client is not a trusted
 * operator console) and wrong for a declared configuration limit. A stale
 * `HUQAN_AGENT_VERSION` in a Claude Desktop config made every `huqan.agent`
 * call fail with a reference number, while the one sentence that would fix it
 * went to a stderr stream that surface never shows anyone.
 *
 * These tests pin both halves: the allowlisted configuration codes reach the
 * client, and everything else stays exactly as opaque as it was.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const { createServer } = require('../mcpServer');
const {
  CONFIGURATION_ERROR_CODES,
  describeConfigurationError,
} = require('../lib/mcp-configuration-errors');

function makeKernel(label) {
  const root = path.join(os.tmpdir(), `huqan-mcp-config-error-${process.pid}-${label}`);
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
}

function silenceStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

async function callTool(server, name, args) {
  return server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function withEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a stale agent-version env var is answered, not hidden behind a reference number', async () => {
  const kernel = makeKernel('agent-version');
  const server = createServer({ kernel });
  try {
    const { result: response, lines } = silenceStderr(() => withEnv(
      { HUQAN_AGENT_VERSION: 'v2' },
      () => callTool(server, 'huqan.agent', { goal: 'kediyi arastir' }),
    ));
    const result = (await response).result;

    assert.equal(result.isError, true, 'the failure is still a failure');
    assert.equal(result.structuredContent.error.code, 'HUQAN_AGENT_VERSION_UNSUPPORTED');
    assert.match(result.content[0].text, /^HUQAN_AGENT_VERSION_UNSUPPORTED: /);
    assert.match(result.content[0].text, /Unset it/, 'the response says what to do about it');
    assert.doesNotMatch(result.content[0].text, /INTERNAL_ERROR|ref:/);
    assert.deepEqual(lines, ['[mcp][tools/call] configuration error code=HUQAN_AGENT_VERSION_UNSUPPORTED'],
      'the operator still sees it, without a reference nothing needs to correlate');
  } finally {
    kernel.graph.close();
    kernel.memory.close();
  }
});

test('two spellings of one environment variable name themselves in the response', async () => {
  const kernel = makeKernel('env-conflict');
  const server = createServer({ kernel });
  try {
    const { result: response } = silenceStderr(() => withEnv(
      { HUQAN_AGENT_VERSION: 'v3', AXIOM_AGENT_VERSION: 'v2' },
      () => callTool(server, 'huqan.agent', { goal: 'kediyi arastir' }),
    ));
    const result = (await response).result;

    assert.equal(result.structuredContent.error.code, 'HUQAN_ENV_CONFLICT');
    assert.match(result.content[0].text, /HUQAN_AGENT_VERSION and AXIOM_AGENT_VERSION/,
      'naming both variables is the whole remedy');
    assert.doesNotMatch(result.content[0].text, /\bv2\b|\bv3\b/,
      'the values are the operator\'s data; the names are what needs fixing');
  } finally {
    kernel.graph.close();
    kernel.memory.close();
  }
});

test('a rejected promise is classified the same way a thrown error is', async () => {
  // huqan.advocate is the async branch of tools/call. The kernel here reports
  // the capability as present so lib/http/read-workflow-actions.js's pre-check
  // passes and the rejection actually reaches the boundary.
  const kernel = {
    learn() {}, verify() {}, graph: {},
    hasCapability: () => true,
    getCapability: () => ({ name: 'devilAdvocate' }),
    runCapability() {
      const error = new Error('/home/operator/private/plugins/devil-advocate.js is missing');
      error.code = 'CAPABILITY_REQUIRED';
      error.capability = 'pluginCapabilities';
      return Promise.reject(error);
    },
  };
  const { result: response } = silenceStderr(() => callTool(
    createServer({ kernel }), 'huqan.advocate', { claim: 'kedi ucar', workspaceId: 'default' },
  ));
  const result = (await response).result;

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'CAPABILITY_REQUIRED');
  assert.match(result.content[0].text, /"pluginCapabilities"/);
  assert.equal(result.content[0].text.includes('/home/operator/private'), false,
    'an allowlisted code must not become a channel for the message that carried it');
});

test('an unrecognised error stays exactly as opaque as before', async () => {
  const kernel = {
    learn() {}, verify() {}, graph: {},
    ask() {
      const error = new Error('SQLITE_CANTOPEN: unable to open /home/operator/private/memory.db');
      error.code = 'SQLITE_CANTOPEN';
      throw error;
    },
  };
  const { result: response } = silenceStderr(() => callTool(
    createServer({ kernel }), 'huqan.ask', { question: 'kedi nedir?' },
  ));
  const result = (await response).result;

  assert.match(result.content[0].text, /^INTERNAL_ERROR \(ref: [0-9a-f]{8}\)$/,
    'a driver code is not a HUQAN configuration code, however code-shaped it looks');
  assert.equal(JSON.stringify(result).includes('/home/operator/private'), false);
});

test('interpolated identifiers come from closed sets, never from the error', () => {
  const conflict = code => Object.assign(new Error('unused'), code);

  assert.match(describeConfigurationError(conflict({
    code: 'HUQAN_ENV_CONFLICT',
    canonicalName: 'HUQAN_PORT',
    legacyName: 'AXIOM_PORT',
  })).message, /HUQAN_PORT and AXIOM_PORT/);

  // A name that is not a spelling of a known suffix is dropped, not echoed.
  const forged = describeConfigurationError(conflict({
    code: 'HUQAN_ENV_CONFLICT',
    canonicalName: 'HUQAN_AWS_SECRET_ACCESS_KEY',
    legacyName: 'AXIOM_AWS_SECRET_ACCESS_KEY',
  })).message;
  assert.equal(forged.includes('AWS_SECRET_ACCESS_KEY'), false);
  assert.match(forged, /Two spellings of one HUQAN environment variable/);

  const unknownCapability = describeConfigurationError(conflict({
    code: 'CAPABILITY_REQUIRED',
    capability: '../../etc/passwd',
  })).message;
  assert.equal(unknownCapability.includes('passwd'), false);
  assert.match(unknownCapability, /a capability that this tool needs/);
});

test('the allowlist stays small and is not silently widened', () => {
  assert.deepEqual(CONFIGURATION_ERROR_CODES, [
    'HUQAN_ENV_CONFLICT',
    'HUQAN_AGENT_VERSION_UNSUPPORTED',
    'CAPABILITY_REQUIRED',
  ]);
  for (const value of [undefined, null, 'string error', {}, new Error('boom'), { code: 'constructor' }]) {
    assert.equal(describeConfigurationError(value), null);
  }
});
