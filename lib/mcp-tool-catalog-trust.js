'use strict';

// #2186: MCP tool schemas for trust receipts, status and audit, in catalog order. lib/mcp-tool-catalog.js
// concatenates the domain arrays back into TOOL_SCHEMAS.

const {
  buildEnvelopeSchema,
} = require('./mcp-envelope-schema');
const {
  TRUST_RECEIPT_DATA_SCHEMA,
  EXPERIENCE_READ_DATA_SCHEMA,
  EXPERIENCE_LEARN_DATA_SCHEMA,
  MEMORY_QUERY_DATA_SCHEMA,
  SYSTEM_STATUS_SCHEMA,
  COMPLIANCE_AUDIT_SCHEMA,
} = require('./mcp-tool-data-schemas');

const TRUST_TOOL_SCHEMAS = [
  {
    name: 'huqan.trust_receipt',
    title: 'HUQAN Trust Receipt',
    description: 'Read a workspace-scoped Trust Receipt using the canonical provenance query projection.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', maxLength: 128 },
        targetId: { type: 'string', maxLength: 128 },
        provenanceId: { type: 'string', maxLength: 128 },
        sourceRef: { type: 'string', maxLength: 256 },
        candidateId: { type: 'string', maxLength: 128 },
        eventType: { type: 'string', maxLength: 32 },
      },
      required: ['workspaceId'],
      additionalProperties: false,
      anyOf: [
        { required: ['targetId'] },
        { required: ['provenanceId'] },
        { required: ['sourceRef'] },
        { required: ['candidateId'] },
        { required: ['eventType'] },
      ],
    },
    outputSchema: buildEnvelopeSchema(TRUST_RECEIPT_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.trust_receipt_detail',
    title: 'HUQAN Trust Receipt Detail',
    // The counterpart to huqan.trust_receipt: that tool searches by what a
    // receipt is about, this one opens the receipt whose id a tool response has
    // already handed the caller.
    description: 'Read one Trust Receipt by its receipt id, workspace-scoped.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', minLength: 1, maxLength: 128, description: 'Workspace that owns the receipt.' },
        receiptId: { type: 'string', minLength: 1, maxLength: 256, description: 'Receipt id, as returned in receiptId by any tool response.' },
      },
      required: ['workspaceId', 'receiptId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(TRUST_RECEIPT_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.memory_query',
    title: 'HUQAN Memory Query',
    description: 'Search memory records in one workspace by text, ranked by BM25 relevance (retrievalMode substring for exact-phrase matching, recency for newest-first half-life decay with no text required). Unprovenanced or inactive records are withheld; degraded ones are returned and marked. Searches memory records, not graph nodes (see huqan.search).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500 },
        workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
        retrievalMode: { enum: ['bm25', 'substring', 'recency'] },
        halfLifeDays: { type: 'number', exclusiveMinimum: 0 },
        asOf: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        explain: { type: 'boolean' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(MEMORY_QUERY_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.experience_read',
    title: 'HUQAN Experience Read',
    description: 'Read one sealed, workspace-scoped Experience run projection by run id.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, maxLength: 128 },
        workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['runId', 'workspaceId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(EXPERIENCE_READ_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.experience_learn',
    title: 'HUQAN Experience Learn',
    description: 'Derive a learning proposal for one sealed, workspace-scoped Experience run. An eligible positive run admits and, when compile params are supplied, compiles a procedure candidate. Proposes; never installs.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, maxLength: 128 },
        workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
        kind: { type: 'string', minLength: 1, maxLength: 64 },
        sourceRunIds: {
          type: 'array',
          description: 'Prior sealed runs this run is measured against (run A→B baseline). Each is read back and its sealed source hash is bound into the proposal hash; a missing, open, mismatched or tampered baseline refuses the proposal.',
          items: { type: 'string', minLength: 1, maxLength: 128 },
          maxItems: 32,
          uniqueItems: true,
        },
        params: {
          type: 'object',
          description: 'Compile params for the procedure candidate. Omit to admit without compiling; a positive run then reports compileCode "bad_params" and procedure null.',
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 512 },
            oldText: { type: 'string', minLength: 1, maxLength: 4096 },
            newText: { type: 'string', minLength: 1, maxLength: 4096 },
          },
          required: ['path', 'oldText', 'newText'],
          additionalProperties: false,
        },
      },
      required: ['runId', 'workspaceId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(EXPERIENCE_LEARN_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.status',
    title: 'HUQAN System Status',
    description: 'Report the current graph state: node and edge counts, entropy, unconnected nodes and detected contradictions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: buildEnvelopeSchema(SYSTEM_STATUS_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.audit',
    title: 'HUQAN Compliance Audit',
    description: 'Build the EU AI Act compliance report (Art 12 record-keeping, Art 13 transparency, Art 14 human oversight) from the receipt chain.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', minLength: 1, maxLength: 128, description: 'Workspace to report on. Defaults to default.' },
      },
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(COMPLIANCE_AUDIT_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

module.exports = { TRUST_TOOL_SCHEMAS };
