'use strict';

// #3907: ask/advocate participate in the same tenancy model as verify/search/
// learn-review. The contract used to lock their workspaceId to 'default', so a
// second workspace could learn and search its facts but never ask a grounded
// question about them. These tests pin the unlocked behavior end to end: the
// HTTP ask reads the requested workspace, the MCP ask tool forwards its new
// optional workspaceId, the advocate capability receives the named workspace,
// the CLI ask/learn commands accept --workspace, and an unknown CLI flag fails
// loudly instead of silently merging into the question or fact text.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');
const { runReadWorkflow, NO_CAPABILITY_ENSURE } = require('../lib/http/read-workflow-actions');
const { httpRequestSchemaForWorkflow } = require('../lib/workflow-contract');
const { TOOL_SCHEMAS } = require('../lib/mcp-tool-catalog');
const { callTool } = require('../mcpServer');
const { askCommand, teachCommand } = require('../lib/cli-knowledge-commands');

const BYPASS = Kernel.createAdmissionBypassOpts('ask-workspace-tenancy');

const tempDirs = [];
let counter = 0;

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeKernel(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-ask-tenancy-${label}-`));
  tempDirs.push(dir);
  counter += 1;
  return new Kernel({
    memoryPath: path.join(dir, `memory-${counter}.json`),
    useSQLite: false,
    noLoad: true,
    loadPlugins: false,
  });
}

// Two workspaces hold mutually exclusive facts about the same subject, the way
// two teams would: 'kedi ucar' lives in default, 'kedi yuzer' only in billing.
function seedSplitWorkspaces(kernel) {
  assert.equal(kernel.learn('kedi ucar', { ...BYPASS, workspaceId: 'default' }).ok, true);
  assert.equal(kernel.learn('kedi yuzer', { ...BYPASS, workspaceId: 'billing' }).ok, true);
}

test('HTTP ask answers from the requested workspace instead of always default (#3907)', async () => {
  const kernel = makeKernel('http');
  seedSplitWorkspaces(kernel);

  const billing = await runReadWorkflow({
    workflowId: 'ask', kernel, input: { question: 'kedi nedir', workspaceId: 'billing' }, ensureCapabilities: NO_CAPABILITY_ENSURE,
  });
  assert.equal(billing.statusCode, 200);
  assert.equal(billing.body.ok, true);
  assert.match(billing.body.data.answer, /yuzer/, `billing ask must read billing: ${billing.body.data.answer}`);
  assert.ok(!billing.body.data.answer.includes('ucar'), `billing ask leaked a default fact: ${billing.body.data.answer}`);

  const fallback = await runReadWorkflow({
    workflowId: 'ask', kernel, input: { question: 'kedi nedir', workspaceId: 'default' }, ensureCapabilities: NO_CAPABILITY_ENSURE,
  });
  assert.equal(fallback.statusCode, 200);
  assert.match(fallback.body.data.answer, /ucar/);
  assert.ok(!fallback.body.data.answer.includes('yuzer'), `default ask leaked a billing fact: ${fallback.body.data.answer}`);
});

test('HTTP ask stays honest for a workspace that holds nothing (#3907)', async () => {
  const kernel = makeKernel('http-unknown');
  seedSplitWorkspaces(kernel);

  const ghost = await runReadWorkflow({
    workflowId: 'ask', kernel, input: { question: 'kedi nedir', workspaceId: 'ghost-workspace' }, ensureCapabilities: NO_CAPABILITY_ENSURE,
  });
  assert.equal(ghost.statusCode, 200);
  assert.equal(ghost.body.data.unknown, true, 'an empty workspace must not answer from another one');
});

test('MCP ask uses the requested workspace scope (#3907)', async () => {
  const kernel = makeKernel('mcp');
  seedSplitWorkspaces(kernel);

  const scoped = await callTool(kernel, { name: 'huqan.ask', arguments: { question: 'kedi nedir', workspaceId: 'billing' } });
  assert.equal(scoped.ok, true);
  assert.match(scoped.data.answer, /yuzer/);

  const unscoped = await callTool(kernel, { name: 'huqan.ask', arguments: { question: 'kedi nedir' } });
  assert.equal(unscoped.ok, true);
  assert.match(unscoped.data.answer, /ucar/);
});

test('the MCP ask tool declares the optional workspace scope without requiring it (#3907)', () => {
  const askTool = TOOL_SCHEMAS.find(tool => tool.name === 'huqan.ask');
  assert.ok(askTool, 'huqan.ask must stay in the catalog');
  assert.deepEqual(askTool.inputSchema.required, ['question']);
  assert.equal(askTool.inputSchema.properties.workspaceId.type, 'string');
  assert.equal(askTool.inputSchema.properties.workspaceId.maxLength, 128);
});

test('the ask/advocate HTTP schemas accept any workspaceId (#3907)', () => {
  for (const workflowId of ['ask', 'advocate']) {
    const schema = httpRequestSchemaForWorkflow(workflowId);
    assert.equal(schema.properties.workspaceId.type, 'string', `${workflowId} workspaceId must be a free string`);
    assert.equal(schema.properties.workspaceId.const, undefined, `${workflowId} must not lock workspaceId to 'default'`);
    assert.equal(schema.properties.workspaceId.maxLength, 128);
    assert.ok(schema.required.includes('workspaceId'));
  }
});

test('HTTP advocate forwards the requested workspace to the capability (#3907)', async () => {
  const seen = [];
  const kernel = {
    hasCapability: () => true,
    getCapability: name => (name === 'devilAdvocate' ? { name } : null),
    async runCapability(name, input) {
      seen.push([name, input]);
      return { data: { mode: 'counter', confidence: 0.5 } };
    },
  };

  const result = await runReadWorkflow({
    workflowId: 'advocate', kernel, input: { claim: 'kedi ucar', workspaceId: 'billing' }, ensureCapabilities: NO_CAPABILITY_ENSURE,
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(seen, [['devilAdvocate', { text: 'kedi ucar', workspaceId: 'billing' }]]);
});

test('CLI ask/learn accept --workspace and reject unknown flags (#3907)', () => {
  const asks = [];
  const askCli = {
    kernel: {
      ask(question, options) {
        asks.push([question, options]);
        return { data: { answer: 'Cevap', unknown: false } };
      },
    },
  };

  const scoped = askCommand(askCli, 'kedi nedir --workspace billing');
  assert.equal(scoped, 'Cevap: Cevap');
  assert.deepEqual(asks, [['kedi nedir', { workspaceId: 'billing' }]]);

  const plain = askCommand(askCli, 'kedi nedir');
  assert.equal(plain, 'Cevap: Cevap');
  assert.deepEqual(asks, [['kedi nedir', { workspaceId: 'billing' }], ['kedi nedir', undefined]]);

  const unknownFlag = askCommand(askCli, 'kedi nedir --verbose x');
  assert.match(unknownFlag, /Bilinmeyen bayrak: --verbose/);
  assert.match(unknownFlag, /--workspace/);

  const danglingFlag = askCommand(askCli, 'kedi nedir --workspace');
  assert.match(danglingFlag, /Bilinmeyen bayrak: --workspace/);

  const learns = [];
  const learnCli = {
    kernel: {
      learn(text, options) {
        learns.push([text, options]);
        return { ok: true, data: { learned: 1 } };
      },
    },
  };

  const learned = teachCommand(learnCli, 'kedi hayvandir --workspace billing');
  assert.match(learned, /öğrendim/);
  assert.deepEqual(learns, [['kedi hayvandir', {
    sourceType: 'cli', sourceRef: 'cli:öğret', actor: 'cli-user', workspaceId: 'billing',
  }]]);

  const learnUnknown = teachCommand(learnCli, 'kedi hayvandir --dry-run');
  assert.match(learnUnknown, /Bilinmeyen bayrak: --dry-run/);
});
