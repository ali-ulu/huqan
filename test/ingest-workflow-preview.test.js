'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildIngestWorkflowPreview, SOURCE_MANIFEST_VERSION } = require('../lib/ingest-workflow-preview');
const { createWorkflowDataRoutes } = require('../lib/http/workflow-data-routes');

const manual = () => ({
  sourceType: 'manual',
  text: 'A reviewed manual fact',
  title: 'manual-source',
  author: 'operator',
  workspaceId: 'default',
  idempotencyKey: 'manual-1',
});

describe('ingest workflow preview', () => {
  it('projects the existing approval snapshot without mutation bytes', () => {
    const preview = buildIngestWorkflowPreview(manual());
    assert.equal(preview.ok, true);
    assert.equal(preview.sourceManifest.version, SOURCE_MANIFEST_VERSION);
    assert.equal(preview.sourceManifest.sourceType, 'manual');
    assert.match(preview.sourceManifest.sourceDigest, /^sha256:/);
    assert.equal(preview.review.required, true);
    assert.equal(preview.review.canonicalWrite, false);
    assert.deepEqual(preview.progress, { completed: 0, total: 1, hasMore: false });
    assert.equal(JSON.stringify(preview).includes('A reviewed manual fact'), false);
  });

  it('fails closed for external sources instead of rebuilding reviewed-external', () => {
    const preview = buildIngestWorkflowPreview({ sourceType: 'github', repoUrl: 'https://github.com/ali-ulu/huqan' });
    assert.equal(preview.ok, false);
    assert.equal(preview.code, 'INGEST_SNAPSHOT_REQUIRED');
  });

  it('serves the preview with the shared envelope and no-store policy', async () => {
    const writes = [];
    const handler = createWorkflowDataRoutes({
      getApprovalStore: () => ({}),
      decideApproval: async () => ({}),
      readReceipt: () => ({}),
      parseJsonRequest: async () => manual(),
      writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
    });
    assert.equal(await handler({ method: 'POST' }, {}, new URL('/api/v2/ingest/preview', 'http://localhost')), true);
    assert.equal(writes[0].status, 200);
    assert.equal(writes[0].json.workflowId, 'ingest-preview');
    assert.equal(writes[0].json.data.review.nextAction, 'submit_ingest_execute');
    assert.equal(writes[0].headers['Cache-Control'], 'no-store');
  });
});
