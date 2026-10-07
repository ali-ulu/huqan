'use strict';

// #3483: tools/call results are held to the output schema each tool
// advertises. Pins the validator, the envelope completion, the fail-closed
// refusal, the declared/applied split in tools/list, and end-to-end
// conformance with a real kernel over JSON-RPC.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  conformanceError,
  unsupportedKeywords,
} = require('../lib/mcp/output-schema-conformance');
const {
  OUTPUT_SCHEMA_VIOLATION,
  APPLIED_OUTPUT_TOOLS,
  DECLARED_ONLY_OUTPUT_TOOLS,
  completeMcpEnvelope,
  conformMcpToolOutput,
  outputConformanceSurface,
} = require('../lib/mcp/output-conformance-gate');
const { MODEL_VISIBLE_TOOL_SCHEMAS, OPERATOR_TOOL_SCHEMAS } = require('../lib/mcp/tool-surface');
const { CONTRACT_VERSION } = require('../lib/kernel-contract');

const ADVERTISED = [...MODEL_VISIBLE_TOOL_SCHEMAS, ...OPERATOR_TOOL_SCHEMAS];
const schemaOf = name => ADVERTISED.find(tool => tool.name === name).outputSchema;

function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

const KERNEL = {
  contractVersion: '9.9.9',
  paranoidMode: true,
  graph: { getStats: () => ({ backend: 'json' }) },
};

test('every advertised output schema uses only keywords the gate can enforce', () => {
  assert.ok(ADVERTISED.length > 0);
  for (const tool of ADVERTISED) {
    assert.ok(tool.outputSchema, `${tool.name} advertises an output schema`);
    assert.deepEqual([...unsupportedKeywords(tool.outputSchema)], [], tool.name);
  }
});

test('the validator enforces type unions, anyOf, required and closed objects', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: ['string', 'null'] },
      count: { type: 'integer', minimum: 0, maximum: 3 },
      tag: { type: 'string', pattern: '^t-', maxLength: 5 },
      kind: { enum: ['a', 'b'] },
      fixed: { const: true },
      nested: { anyOf: [{ type: 'null' }, { type: 'object', required: ['x'], additionalProperties: false, properties: { x: { type: 'boolean' } } }] },
      list: { type: 'array', maxItems: 2, items: { type: 'number' } },
    },
    required: ['id'],
    additionalProperties: false,
  };
  const valid = { id: null, count: 3, tag: 't-1', kind: 'a', fixed: true, nested: { x: false }, list: [1, 2.5] };
  assert.equal(conformanceError(valid, schema), null);
  assert.equal(conformanceError({ ...valid, nested: null }, schema), null);

  const cases = [
    [{ count: 1 }, 'structuredContent.id is required'],
    [{ ...valid, id: 4 }, 'structuredContent.id must be of type string|null'],
    [{ ...valid, count: 1.5 }, 'structuredContent.count must be of type integer'],
    [{ ...valid, count: 4 }, 'structuredContent.count must be at most 3'],
    [{ ...valid, count: -1 }, 'structuredContent.count must be at least 0'],
    [{ ...valid, tag: 'x-1' }, 'structuredContent.tag does not match its pattern'],
    [{ ...valid, tag: 't-12345' }, 'structuredContent.tag is too long'],
    [{ ...valid, kind: 'c' }, 'structuredContent.kind must be one of the documented values'],
    [{ ...valid, fixed: false }, 'structuredContent.fixed must equal its constant'],
    [{ ...valid, nested: { x: 1 } }, 'structuredContent.nested matches none of its allowed shapes'],
    [{ ...valid, nested: { x: true, y: 1 } }, 'structuredContent.nested matches none of its allowed shapes'],
    [{ ...valid, list: [1, 2, 3] }, 'structuredContent.list must contain at most 2 items'],
    [{ ...valid, list: ['1'] }, 'structuredContent.list[0] must be of type number'],
    [{ ...valid, extra: 1 }, 'structuredContent.extra is not allowed'],
    [[], 'structuredContent must be of type object'],
  ];
  for (const [value, expected] of cases) assert.equal(conformanceError(value, schema), expected);
  // NaN and Infinity are not JSON numbers.
  assert.equal(conformanceError(Number.NaN, { type: 'number' }), 'structuredContent must be of type number');
});

test('an unknown schema keyword refuses instead of skipping its constraint', () => {
  assert.equal(
    conformanceError('x', { type: 'string', format: 'email' }),
    'structuredContent uses unsupported schema keyword format',
  );
  assert.deepEqual([...unsupportedKeywords({ properties: { a: { oneOf: [] } }, items: { not: {} } })], ['oneOf', 'not']);
  assert.equal(conformanceError('x', null), 'structuredContent has no usable schema');
});

test('envelope completion fills only absent fields, from their true sources', () => {
  const completed = completeMcpEnvelope(KERNEL, 'huqan.status', { workflowId: 'system-status', meta: { source: 's' } });
  assert.equal(completed.ok, true);
  assert.equal(completed.type, 'system-status');
  assert.equal(completed.data, null);
  assert.deepEqual(completed.evidence, []);
  assert.equal(completed.error, null);
  assert.deepEqual(completed.meta, { contractVersion: '9.9.9', backend: 'json', paranoidMode: true, source: 's' });

  const present = {
    ok: false, type: 'ask', data: { a: 1 }, evidence: [{ kind: 'path' }], error: { code: 'E', message: 'm' },
    meta: { contractVersion: '1.0.0', backend: 'sqlite', paranoidMode: false },
  };
  assert.deepEqual(completeMcpEnvelope(KERNEL, 'huqan.ask', present), present);

  // A kernel without a contract version reports the code's own.
  assert.equal(completeMcpEnvelope({}, 'huqan.ask', {}).meta.contractVersion, CONTRACT_VERSION);
  assert.equal(completeMcpEnvelope({}, 'huqan.ask', {}).meta.backend, 'unknown');
  assert.equal(completeMcpEnvelope(KERNEL, 'huqan.ask', null), null);
});

test('a result that breaks its declared schema is withheld fail-closed', () => {
  const drifted = { ok: true, workflowId: 'system-status', data: { answer: 'secret-answer' } };
  const refused = quietly(() => conformMcpToolOutput(KERNEL, 'huqan.status', drifted));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, OUTPUT_SCHEMA_VIOLATION);
  assert.match(refused.error.message, /\(ref: [0-9a-f]{8}\)/);
  assert.equal(refused.data, null);
  assert.deepEqual(refused.evidence, []);
  assert.ok(!JSON.stringify(refused).includes('secret-answer'), 'the withheld result is not echoed');
  // Same drift, same reference.
  const again = quietly(() => conformMcpToolOutput(KERNEL, 'huqan.status', drifted));
  assert.equal(again.error.message, refused.error.message);
});

test('a declared-only tool is completed but not withheld', () => {
  assert.ok(Object.hasOwn(DECLARED_ONLY_OUTPUT_TOOLS, 'huqan.search'));
  const drifted = { ok: true, workflowId: 'memory-search', data: { items: [], returned: 0 } };
  const passed = conformMcpToolOutput(KERNEL, 'huqan.search', drifted);
  assert.notEqual(conformanceError(passed, schemaOf('huqan.search')), null, 'the drift is real');
  assert.deepEqual(passed.data, drifted.data);
  assert.equal(passed.error, null);
  assert.equal(passed.meta.contractVersion, '9.9.9');
});

test('every refusal conforms to its tool schema and carries nothing from the withheld result', () => {
  const drifted = [
    { ok: false, secretTop: 'LEAK-TOP', meta: { x: 'LEAK-META', paranoidMode: 'yes' }, error: { code: 'X', message: 'LEAK-MSG' } },
    { workflowId: 42, trace: { step: 'LEAK-TRACE' }, provenance: { sourceRef: 'LEAK-PROV' } },
    'LEAK-STRING',
    ['LEAK-ARRAY'],
    { canonicalWrite: true, receiptId: 'rcpt-1', data: 'LEAK-DATA', evidence: 'nope' },
  ];
  for (const tool of ADVERTISED.filter(entry => !Object.hasOwn(DECLARED_ONLY_OUTPUT_TOOLS, entry.name))) {
    for (const result of drifted) {
      const refused = quietly(() => conformMcpToolOutput(KERNEL, tool.name, result));
      assert.equal(refused.error.code, OUTPUT_SCHEMA_VIOLATION, tool.name);
      assert.equal(conformanceError(refused, tool.outputSchema), null, `${tool.name} refusal conforms`);
      assert.ok(!JSON.stringify(refused).includes('LEAK'), `${tool.name} refusal leaks nothing`);
      assert.deepEqual(refused.meta, { contractVersion: '9.9.9', backend: 'json', paranoidMode: true });
    }
  }
  // What already happened is not hidden by the refusal.
  const wrote = quietly(() => conformMcpToolOutput(KERNEL, 'huqan.learn', drifted[4]));
  assert.equal(wrote.canonicalWrite, true);
  assert.equal(wrote.receiptId, 'rcpt-1');
  const didNot = quietly(() => conformMcpToolOutput(KERNEL, 'huqan.learn', drifted[0]));
  assert.equal(didNot.canonicalWrite, false);
  assert.equal(didNot.receiptId, null);
});

test('conforming results pass and unknown tools are only completed', () => {
  const ok = conformMcpToolOutput(KERNEL, 'huqan.ask', {
    ok: true, workflowId: 'ask', version: '2.0.0', status: 'done', type: 'ask',
    data: { answer: 'a', subject: 's', unknown: false, alternatives: 0 },
    evidence: [], confidence: null, policy: null, approval: null, canonicalWrite: false,
    candidateId: null, provenance: null, audit: null, receipt: null, trace: null, receiptId: null, error: null,
  });
  assert.equal(ok.ok, true);
  assert.equal(conformanceError(ok, schemaOf('huqan.ask')), null);
  assert.deepEqual(conformMcpToolOutput(KERNEL, 'huqan.nope', { ok: true }).meta.backend, 'json');
});

test('tools/list publishes which declarations tools/call enforces', () => {
  const surface = outputConformanceSurface();
  const declaredOnly = surface.declaredOnly.map(entry => entry.tool);
  assert.deepEqual([...surface.applied, ...declaredOnly].sort(), ADVERTISED.map(tool => tool.name).sort());
  assert.deepEqual(surface.applied, [...APPLIED_OUTPUT_TOOLS]);
  for (const entry of surface.declaredOnly) {
    assert.equal(typeof entry.reason, 'string', `${entry.tool} names the drift that keeps it declared-only`);
    assert.ok(entry.reason.length > 0);
  }
  assert.deepEqual(Object.keys(DECLARED_ONLY_OUTPUT_TOOLS).sort(), declaredOnly);
});

test('real kernel results conform to their advertised schemas over JSON-RPC', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-output-conformance-'));
  const { createServer } = require('../mcpServer');
  const server = createServer({
    kernelOpts: { noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(root, 'memory.json') },
    approvalStore: null,
  });
  t.after(async () => {
    await server.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const list = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result._meta.outputConformance, outputConformanceSurface());
  const advertised = new Map(list.result.tools.map(tool => [tool.name, tool.outputSchema]));

  const calls = [
    ['huqan.status', {}],
    ['huqan.ask', { question: 'kedi nedir' }],
    // kernel.ask answers "neden ..." through reason and returns reason data.
    ['huqan.ask', { question: 'neden kedi' }],
    ['huqan.verify', { claim: 'kedi hayvandir' }],
    ['huqan.reason', { subject: 'kedi' }],
    ['huqan.compare', { left: 'kedi', right: 'kopek' }],
    ['huqan.plan', { goal: 'kedi hayvandir mi' }],
    ['huqan.learn', { text: 'kedi hayvandir' }],
  ];
  for (const [name, args] of calls) {
    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args },
    });
    const content = response.result.structuredContent;
    assert.notEqual(content.error?.code, OUTPUT_SCHEMA_VIOLATION, `${name} was withheld`);
    if (Object.hasOwn(DECLARED_ONLY_OUTPUT_TOOLS, name)) continue;
    assert.equal(conformanceError(content, advertised.get(name)), null, name);
  }
});
