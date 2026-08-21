'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createWorkflowTools } = require('../workflow-tools');
const { createRepoMemoryTool } = require('../lib/workflow-tool-repo-memory');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'workflow-tools.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workflow-tool-repo-memory.js'), 'utf8');

function repoMemoryTool(kernel = {}, options = {}) {
  const tools = createWorkflowTools(kernel, options);
  const tool = tools.find(candidate => candidate.name === 'repoMemory');
  assert.ok(tool, 'repoMemory must remain registered');
  return tool;
}

test('repoMemory adapter is a cycle-free dependency-injected delegate', () => {
  assert.match(runtimeSource, /tools\.push\(createRepoMemoryTool\(\{ kernel, buildEnvelope, normalizeToolInput, resolveCapabilityRunner, resultFromKernel \}\)\);/);
  assert.doesNotMatch(delegateSource, /require\(['"].*workflow-tools/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /\._(tools|registry|storage|memory|nodes|edges|db|stmts)/);
  assert.deepEqual(Object.keys(require('../lib/workflow-tool-repo-memory')), ['createRepoMemoryTool']);
  assert.equal(typeof createRepoMemoryTool, 'function');
});

test('repoMemory fails closed when no capability runner exists', async () => {
  const result = await repoMemoryTool({}).run({}, { sourceType: 'markdown' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'MISSING_METHOD');
  assert.deepEqual(result.data, { sourceType: 'markdown' });
  assert.equal(result.confidence, 0);
});

test('repoMemory preserves request shaping and kernel result envelopes', async () => {
  const calls = [];
  const kernel = {
    async runCapability(name, request, opts) {
      calls.push({ name, request, opts });
      return {
        ok: true,
        data: { stored: 2, sourceType: request.sourceType },
        evidence: [{ id: 'e-1' }],
        confidence: 0.9,
      };
    },
  };
  const context = {
    action: 'query',
    branch: 'context-branch',
    sessionId: 'ctx-session',
    opts: { workspace: 'default' },
  };
  const input = {
    sourceType: 'GitHub',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    branch: 'feature/test',
    token: 'token-value',
    text: 'readme',
    opts: { workspace: 'input' },
  };
  const snapshot = JSON.parse(JSON.stringify(input));

  const result = await repoMemoryTool(kernel).run(context, input);

  assert.deepEqual(input, snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'done');
  assert.deepEqual(result.data, { sourceType: 'github', action: 'query', stored: 2 });
  assert.equal(result.confidence, 0.9);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    name: 'repoMemory',
    request: {
      action: 'query',
      sourceType: 'github',
      repoUrl: 'https://github.com/ali-ulu/huqan',
      url: '',
      path: '',
      targetPath: '',
      branch: 'feature/test',
      token: 'token-value',
      sessionId: 'ctx-session',
      author: '',
      date: '',
      text: 'readme',
    },
    opts: { workspace: 'input' },
  });
});

test('repoMemory converts capability exceptions into fail-closed envelopes', async () => {
  const result = await repoMemoryTool({
    runCapability: async () => {
      throw new Error('capability unavailable');
    },
  }).run({}, { action: 'ingest', sourceType: 'markdown', path: 'README.md' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.equal(result.error.message, 'capability unavailable');
  assert.deepEqual(result.data, { sourceType: 'markdown', action: 'ingest' });
  assert.equal(result.confidence, 0);
});

test('repoMemory uses plugin manager runner only when kernel runner is absent', async () => {
  const calls = [];
  const kernel = {
    plugins: {
      runCapability: async (name, request, opts) => {
        calls.push({ name, request, opts });
        return { ok: true, data: { accepted: true }, confidence: 0.7 };
      },
    },
  };

  const result = await repoMemoryTool(kernel).run({}, { sourceType: 'markdown', path: 'README.md' });

  assert.equal(result.ok, true);
  assert.equal(result.data.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'repoMemory');
});
