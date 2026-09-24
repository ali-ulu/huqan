'use strict';

// #2172: data schemas for ingest preview, execute and run.

const INGEST_PREVIEW_DATA_SCHEMA = {
  type: 'object',
  properties: {
    workflowId: { type: 'string', const: 'ingest-preview' },
    status: { type: 'string', const: 'completed' },
    sourceManifest: {
      type: 'object',
      properties: {
        version: { type: 'string', const: 'huqan.ingest-source-manifest.v1' },
        workspaceId: { type: 'string', const: 'default' },
        sourceType: { type: 'string', enum: ['manual', 'decision'] },
        sourceRef: { type: 'string' },
        sourceDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        idempotencyKey: { type: 'string' },
        itemCount: { type: 'integer', const: 1 },
      },
      required: ['version', 'workspaceId', 'sourceType', 'sourceRef', 'sourceDigest', 'idempotencyKey', 'itemCount'],
      additionalProperties: false,
    },
    review: {
      type: 'object',
      properties: {
        required: { type: 'boolean', const: true },
        canonicalWrite: { type: 'boolean', const: false },
        nextAction: { type: 'string', const: 'submit_ingest_execute' },
        executeRoute: { type: 'string', const: '/api/v2/ingest/execute' },
      },
      required: ['required', 'canonicalWrite', 'nextAction', 'executeRoute'],
      additionalProperties: false,
    },
    progress: {
      type: 'object',
      properties: {
        completed: { type: 'integer', const: 0 },
        total: { type: 'integer', const: 1 },
        hasMore: { type: 'boolean', const: false },
      },
      required: ['completed', 'total', 'hasMore'],
      additionalProperties: false,
    },
  },
  required: ['workflowId', 'status', 'sourceManifest', 'review', 'progress'],
  additionalProperties: false,
};

// Mirrors buildIngestWorkflowRun(), which is also what GET /api/v2/ingest/runs/{id}
// returns, so an MCP client and an HTTP client read the same run projection.
// retry/resume are reported as explicit allowed+reason pairs rather than being
// omitted: "not retryable, and here is why" is a contract a client can act on,
// while a missing field is not.
const INGEST_EXECUTE_DATA_SCHEMA = {
  type: 'object',
  properties: {
    approval: { type: 'object', additionalProperties: true },
    approvalId: { type: 'string' },
    // Same identifier as approvalId, under the name huqan.ingest_status asks
    // for. Both are declared because both are emitted; the HTTP ingest execute
    // response has always carried runId, and a client should not have to know
    // which surface it is talking to in order to find the run.
    runId: { type: 'string' },
    statusRoute: { type: 'string' },
    queuedForExecution: { type: 'boolean' },
    result: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    receipt: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    refs: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
  },
  required: ['approvalId', 'statusRoute', 'queuedForExecution'],
  additionalProperties: true,
};

const INGEST_RUN_DATA_SCHEMA = {
  type: 'object',
  properties: {
    workflowId: { type: 'string', const: 'ingest-run-detail' },
    runId: { type: 'string' },
    status: { type: 'string', enum: ['review_required', 'queued', 'completed', 'blocked', 'failed'] },
    phase: { type: 'string', enum: ['awaiting_review', 'executing', 'finalized', 'rejected', 'reconciliation_required'] },
    sourceManifest: { type: 'object', additionalProperties: true },
    progress: {
      type: 'object',
      properties: {
        completed: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 0 },
        hasMore: { type: 'boolean' },
      },
      required: ['completed', 'total', 'hasMore'],
      additionalProperties: false,
    },
    retry: {
      type: 'object',
      properties: { allowed: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['allowed', 'reason'],
      additionalProperties: false,
    },
    resume: {
      type: 'object',
      properties: { allowed: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['allowed', 'reason'],
      additionalProperties: false,
    },
    nextAction: { type: ['string', 'null'] },
    approvalId: { type: 'string' },
    receiptId: { type: ['string', 'null'] },
    workspaceId: { type: 'string' },
  },
  required: ['workflowId', 'runId', 'status', 'phase', 'progress', 'retry', 'resume', 'approvalId'],
  additionalProperties: true,
};

module.exports = {
  INGEST_EXECUTE_DATA_SCHEMA,
  INGEST_PREVIEW_DATA_SCHEMA,
  INGEST_RUN_DATA_SCHEMA,
};
