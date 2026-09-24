'use strict';

// #2186: MCP tool schemas for ingest preview, execute and status, in catalog order. lib/mcp-tool-catalog.js
// concatenates the domain arrays back into TOOL_SCHEMAS.

const {
  buildEnvelopeSchema,
} = require('./mcp-envelope-schema');
const {
  INGEST_PREVIEW_DATA_SCHEMA,
  INGEST_EXECUTE_DATA_SCHEMA,
  INGEST_RUN_DATA_SCHEMA,
} = require('./mcp-tool-data-schemas');

const INGEST_TOOL_SCHEMAS = [
  {
    name: 'huqan.ingest_preview',
    title: 'HUQAN Ingest Preview',
    description: 'Build a read-only, immutable ingest source manifest for review. External sources fail closed and execution remains on the approval-owned HTTP surface.',
    inputSchema: {
      type: 'object',
      properties: {
        // 'github' and 'markdown' are not offered: immutable snapshot support
        // for them does not exist, so queue admission fails closed with
        // INGEST_SNAPSHOT_REQUIRED on every call (lib/ingest.js, and
        // docs/v5/v5-connector-coverage-matrix.md records the unavailability as
        // intentional). Advertising them in the enum while the description right
        // above says external sources fail closed left a client picking a value
        // the surface can never serve. huqan.ingest_execute already offers only
        // these two, so preview was the outlier of the pair.
        sourceType: { type: 'string', enum: ['manual', 'decision'] },
        workspaceId: { type: 'string' },
        idempotencyKey: { type: 'string', maxLength: 128 },
        text: { type: 'string', maxLength: 4000 },
        title: { type: 'string', maxLength: 512 },
        author: { type: 'string', maxLength: 128 },
        date: { type: 'string', maxLength: 32 },
        rationale: { type: 'string', maxLength: 4000 },
        decidedBy: { type: 'string', maxLength: 128 },
        alternatives: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 512 } },
        links: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 512 } },
      },
      required: ['sourceType'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(INGEST_PREVIEW_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.ingest_execute',
    title: 'HUQAN Ingest Execute',
    description: 'Queue a reviewed manual or decision ingest for approval-owned execution. The call never writes canonical state before approval.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceType: { type: 'string', enum: ['manual', 'decision'] },
        workspaceId: { type: 'string', const: 'default' },
        idempotencyKey: { type: 'string', maxLength: 128 },
        text: { type: 'string', maxLength: 4000 },
        title: { type: 'string', maxLength: 512 },
        author: { type: 'string', maxLength: 128 },
        date: { type: 'string', maxLength: 32 },
        rationale: { type: 'string', maxLength: 4000 },
        decidedBy: { type: 'string', maxLength: 128 },
        alternatives: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 512 } },
        links: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 512 } },
      },
      required: ['sourceType'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(INGEST_EXECUTE_DATA_SCHEMA),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.ingest_status',
    title: 'HUQAN Ingest Run Status',
    description: 'Read the status, progress, retry/resume eligibility and final receipt of an ingest run. Read-only: execution and approval stay on the approval-owned surface.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', maxLength: 128, description: 'Run identifier returned by ingest execute.' },
        workspaceId: { type: 'string', maxLength: 128, description: 'Workspace that owns the run.' },
      },
      required: ['runId', 'workspaceId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(INGEST_RUN_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

module.exports = { INGEST_TOOL_SCHEMAS };
