'use strict';

// #2186: MCP tool schemas for trust receipts, status and audit, in catalog order. lib/mcp-tool-catalog.js
// concatenates the domain arrays back into TOOL_SCHEMAS.

const {
  buildEnvelopeSchema,
} = require('./mcp-envelope-schema');
const {
  TRUST_RECEIPT_DATA_SCHEMA,
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
