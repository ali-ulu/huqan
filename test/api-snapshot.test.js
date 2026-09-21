'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSnapshot } = require('../scripts/api-snapshot-surface');
const { diffSnapshots } = require('../scripts/api-snapshot-diff');

test('API snapshot covers the declared public surfaces', () => {
  const snapshot = buildSnapshot();

  assert.equal(snapshot.formatVersion, 'huqan.api-snapshot.v1');
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);

  const exports = new Set(snapshot.exports.map((item) => item.name));
  assert.ok(exports.has('default'));
  assert.ok(exports.has('KernelV2'));

  const typeNames = new Set(
    snapshot.types.flatMap((file) => file.declarations.map((decl) => `${file.file}:${decl.name}`)),
  );
  assert.ok(typeNames.has('kernel.d.ts:Kernel'));
  assert.ok(typeNames.has('kernel.d.ts:LearnOptions'));

  const commands = new Set(snapshot.cli.canonical.map((item) => item.command));
  assert.ok(commands.has('öğret'));
  assert.ok(commands.has('doctor'));

  const learnTool = snapshot.mcp.find((item) => item.name === 'huqan.learn');
  assert.ok(learnTool);
  assert.ok(learnTool.inputSchema.required.includes('text'));

  const askRoute = snapshot.rest.workflows.find((item) => item.workflowId === 'ask');
  assert.deepEqual({ method: askRoute.method, path: askRoute.path }, {
    method: 'POST',
    path: '/api/v2/workflows/ask',
  });

  const health = snapshot.rest.declared.find((item) => item.id === 'health');
  assert.deepEqual(health.methods, ['GET']);

  assert.ok(snapshot.schemas.some((item) => item.path.endsWith('/trust-receipt.schema.json')));
});

test('API diff rejects removals and newly required MCP input', () => {
  const baseline = buildSnapshot();
  const current = structuredClone(baseline);

  current.exports = current.exports.filter((item) => item.name !== 'KernelV2');
  const learn = current.mcp.find((item) => item.name === 'huqan.learn');
  learn.inputSchema.properties.newRequired = { type: 'string' };
  learn.inputSchema.required = [...learn.inputSchema.required, 'newRequired'];

  const result = diffSnapshots(baseline, current);
  assert.ok(result.breaking.some((item) => item.area === 'exports' && item.key === 'KernelV2'));
  assert.ok(result.breaking.some((item) =>
    item.area === 'mcp'
      && item.key === 'huqan.learn'
      && item.reason.includes('new required input')));
});

test('API diff permits additive optional fields and new tools', () => {
  const baseline = buildSnapshot();
  const current = structuredClone(baseline);

  const learn = current.mcp.find((item) => item.name === 'huqan.learn');
  learn.inputSchema.properties.optionalNote = { type: 'string' };
  current.mcp.push({
    name: 'huqan.example_additive',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    annotations: {},
  });

  const result = diffSnapshots(baseline, current);
  assert.equal(result.breaking.length, 0);
  assert.ok(result.added.some((item) => item.area === 'mcp' && item.key === 'huqan.example_additive'));
});
