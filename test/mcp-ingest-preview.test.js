'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../mcpServer');
const { TOOL_SCHEMAS } = require('../lib/mcp-tool-catalog');

function call(server, sourceType, extra = {}) {
  const response = server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'huqan.ingest_preview', arguments: { sourceType, ...extra } },
  });
  return response.result.structuredContent;
}

test('huqan.ingest_preview is advertised as a bounded read-only workflow', () => {
  const schema = TOOL_SCHEMAS.find(tool => tool.name === 'huqan.ingest_preview');
  assert.ok(schema);
  assert.deepEqual(schema.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(schema.outputSchema.properties.data.anyOf[1].properties.review.properties.canonicalWrite.const, false);
  assert.equal(schema.outputSchema.properties.data.anyOf[1].properties.progress.properties.total.const, 1);
});

test('huqan.ingest_preview returns a stable manual source manifest without approval mutation', () => {
  const server = createServer({
    approvalStore: {
      create() { throw new Error('preview must not create approvals'); },
      list() { throw new Error('preview must not discover approval authority'); },
    },
  });
  const result = call(server, 'manual', { text: 'bounded source', idempotencyKey: 'preview-1' });

  assert.equal(result.ok, true);
  assert.equal(result.workflowId, 'ingest-preview');
  assert.equal(result.status, 'completed');
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.data.sourceManifest.version, 'huqan.ingest-source-manifest.v1');
  assert.equal(result.data.sourceManifest.sourceType, 'manual');
  assert.equal(result.data.sourceManifest.idempotencyKey, 'preview-1');
  assert.match(result.data.sourceManifest.sourceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.data.progress, { completed: 0, total: 1, hasMore: false });
  assert.deepEqual(result.data.review, {
    required: true,
    canonicalWrite: false,
    nextAction: 'submit_ingest_execute',
    executeRoute: '/api/v2/ingest/execute',
  });
});

test('huqan.ingest_preview fails closed for external sources', () => {
  const result = call(createServer(), 'github', { title: 'not a reviewed snapshot' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.error.code, 'INGEST_SNAPSHOT_REQUIRED');
  assert.equal(result.data, null);
});

/**
 * The test above proves external sources fail closed. That behaviour was
 * correct while the advertised enum still offered `github` and `markdown`, so
 * a client reading the schema could pick a value the surface can never serve —
 * immutable snapshot support for them does not exist, and
 * docs/v5/v5-connector-coverage-matrix.md records that as intentional, not as
 * a deployment toggle. The tool's own description already said external
 * sources fail closed; only the enum disagreed.
 *
 * Preview and execute are advertised as consecutive steps of one flow, so a
 * source type offered by the first has to be accepted by the second.
 */
test('the advertised source types are the ones both ingest steps accept', () => {
  const sourceTypes = (toolName) => TOOL_SCHEMAS
    .find(tool => tool.name === toolName)
    .inputSchema.properties.sourceType.enum;

  assert.deepEqual(sourceTypes('huqan.ingest_preview'), ['manual', 'decision']);
  assert.deepEqual(sourceTypes('huqan.ingest_preview'), sourceTypes('huqan.ingest_execute'));
});
