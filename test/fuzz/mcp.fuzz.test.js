'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fc = require('fast-check');

const { MODEL_VISIBLE_TOOL_SCHEMAS } = require('../../mcpServer');
const { createJsonRpcHandler } = require('../../lib/mcp/json-rpc-handler');

const malformedParamsArb = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.string({ maxLength: 512 }),
  fc.array(fc.jsonValue(), { maxLength: 8 }),
);

function fuzzHandler() {
  return createJsonRpcHandler({
    callTool: (params) => ({
      ok: false,
      type: 'fuzz',
      data: null,
      evidence: [],
      error: {
        code: 'INVALID_PARAMS',
        message: 'malformed params rejected',
      },
      meta: { receivedType: Array.isArray(params) ? 'array' : typeof params },
    }),
  });
}

test('MCP JSON-RPC fuzz: initialize, tools/list and tools/call never crash on malformed params', { timeout: 10000 }, async () => {
  const handle = fuzzHandler();
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('initialize', 'tools/list', 'tools/call'),
      malformedParamsArb,
      fc.integer(),
      async (method, params, id) => {
        const response = await Promise.resolve(handle({ jsonrpc: '2.0', id, method, params }));
        assert.ok(response && typeof response === 'object');
        assert.equal(response.jsonrpc, '2.0');
        assert.equal(response.id, id);
        if (method === 'tools/list') {
          assert.deepEqual(response.result.tools, MODEL_VISIBLE_TOOL_SCHEMAS);
        }
        if (method === 'tools/call') {
          assert.equal(response.result.isError, true);
          assert.equal(response.result.structuredContent.error.code, 'INVALID_PARAMS');
        }
      },
    ),
    { numRuns: 180 },
  );
});

test('MCP JSON-RPC fuzz: arbitrary JSON messages are bounded responses, not throws', { timeout: 10000 }, async () => {
  const handle = fuzzHandler();
  await fc.assert(
    fc.asyncProperty(fc.jsonValue(), async (message) => {
      const response = await Promise.resolve(handle(message));
      if (response === null) return;
      assert.ok(response && typeof response === 'object');
      assert.equal(response.jsonrpc, '2.0');
    }),
    { numRuns: 180 },
  );
});
