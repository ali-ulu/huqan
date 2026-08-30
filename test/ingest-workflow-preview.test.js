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
      proposeLearn: async () => ({ approval: { id: 'approval-learn', persisted: true, context: {} } }),
      submitIngest: async () => ({}),
      createAgent: () => ({ plan: () => ({ ok: true, data: {} }), run: () => ({ ok: true, data: {} }) }),
    });
    assert.equal(await handler({ method: 'POST' }, {}, new URL('/api/v2/ingest/preview', 'http://localhost')), true);
    assert.equal(writes[0].status, 200);
    assert.equal(writes[0].json.workflowId, 'ingest-preview');
    assert.equal(writes[0].json.data.review.nextAction, 'submit_ingest_execute');
    assert.equal(writes[0].headers['Cache-Control'], 'no-store');
  });

  it('routes versioned execute through the injected persistent action owner', async () => {
    const writes = [];
    const calls = [];
    const handler = createWorkflowDataRoutes({
      getApprovalStore: () => ({}), decideApproval: async () => ({}), readReceipt: () => ({}),
      parseJsonRequest: async () => manual(),
      writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
      proposeLearn: async () => ({ approval: { id: 'approval-learn', persisted: true, context: {} } }),
      submitIngest: async input => { calls.push(input); return { status: 202, json: { approval: { id: 'approval-1' } } }; },
      createAgent: () => ({ plan: () => ({ ok: true, data: {} }), run: () => ({ ok: true, data: {} }) }),
    });
    assert.equal(await handler({ method: 'POST' }, {}, new URL('/api/v2/ingest/execute', 'http://localhost')), true);
    assert.equal(calls.length, 1);
    assert.equal(writes[0].status, 202);
    assert.equal(writes[0].json.workflowId, 'ingest-execute');
    assert.equal(writes[0].json.status, 'review_required');
    assert.equal(writes[0].json.ok, false);
    assert.equal(writes[0].json.data.runId, 'approval-1');
    assert.equal(writes[0].json.data.statusRoute, '/api/v2/ingest/runs/approval-1');
    assert.equal(writes[0].headers['Cache-Control'], 'no-store');
  });

  it('learn route requires an exact workspace and projects review admission', async () => {
    const writes = [];
    const calls = [];
    let body = {
      workspaceId: 'workspace-a',
      text: 'cats are animals',
      provenance: {
        workspaceId: 'workspace-b',
        actor: 'forged-actor',
        provenanceId: 'forged-provenance',
        sourceRef: 'forged-ref',
        sourceTitle: 'forged-title',
        sourceType: 'forged-type',
        timestamp: '2020-01-01T00:00:00.000Z',
        confidence: 1,
      },
    };
    const handler = createWorkflowDataRoutes({
      getApprovalStore: () => ({}), decideApproval: async () => ({}), readReceipt: () => ({}),
      parseJsonRequest: async () => body,
      writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
      submitIngest: async () => ({}),
      createAgent: () => ({ plan: () => ({ ok: true, data: {} }), run: () => ({ ok: true, data: {} }) }),
      proposeLearn: async proposal => {
        calls.push(proposal);
        return {
          gate: { decision: 'review', reason: 'mutating_requires_review' },
          approval: {
            id: 'approval-1',
            persisted: true,
            context: {
              candidateId: 'candidate-1',
              provenance: proposal.provenance,
            },
          },
        };
      },
    });
    assert.equal(await handler({ method: 'POST' }, {}, new URL('/api/v2/workflows/learn', 'http://localhost')), true);
    assert.equal(calls[0].workspaceId, 'workspace-a');
    assert.equal(calls[0].text, 'cats are animals');
    assert.deepEqual(calls[0].provenance, {
      workspaceId: 'workspace-a',
      actor: 'http-api',
      sourceRef: '/api/v2/workflows/learn',
      sourceTitle: 'HTTP workflow learn',
      sourceType: 'upload',
    });
    assert.equal(writes[0].status, 202);
    assert.equal(writes[0].json.status, 'review_required');
    assert.equal(writes[0].json.data.approvalId, 'approval-1');
    assert.equal(writes[0].json.data.candidateId, 'candidate-1');
    assert.equal(writes[0].json.approval.persisted, true);
    body = { text: 'missing workspace' };
    await handler({ method: 'POST' }, {}, new URL('/api/v2/workflows/learn', 'http://localhost'));
    assert.equal(writes[1].status, 400);
    assert.equal(writes[1].json.error.code, 'INVALID_INPUT');
  });
});
