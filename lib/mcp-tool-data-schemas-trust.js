'use strict';

// #2172: data schemas for memory search, trust receipts and verify.

const { VERIFY_STATUS, CONTRADICTION_REASONS, RISK_SCHEMA } = require('./mcp-envelope-schema');

const MEMORY_SEARCH_DATA_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    total: { type: 'integer', minimum: 0 },
    workspaceId: { type: 'string' },
  },
  required: ['items', 'total', 'workspaceId'],
  additionalProperties: true,
};

const TRUST_RECEIPT_DATA_SCHEMA = {
  type: 'object',
  properties: {
    receiptId: { type: 'string' },
    status: { type: 'string' },
    workspaceId: { type: 'string' },
    provenance: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    auditTrail: { type: 'array', items: { type: 'object', additionalProperties: true } },
    canonical: { type: 'boolean' },
  },
  required: ['receiptId', 'status', 'workspaceId', 'auditTrail', 'canonical'],
  additionalProperties: true,
};

const VERIFY_DATA_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: VERIFY_STATUS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    inferred: { type: 'boolean' },
    contradictionReason: { type: 'string', enum: CONTRADICTION_REASONS },
    confidenceSource: { type: 'string' },
    pathLength: { type: 'integer', minimum: 1 },
    reasoningPath: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          relation: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'relation', 'to'],
        additionalProperties: false,
      },
    },
    evidenceSummary: { type: 'array', items: { type: 'string' } },
    explanation: { type: 'string' },
    knownTypes: { type: 'array', items: { type: 'string' } },
    requestedType: { type: 'string' },
    requestedTarget: { type: 'string' },
    conflictTarget: { type: 'string' },
    risk: { anyOf: [{ type: 'null' }, RISK_SCHEMA] },
  },
  required: ['status', 'confidence'],
  additionalProperties: true,
};

module.exports = {
  MEMORY_SEARCH_DATA_SCHEMA,
  TRUST_RECEIPT_DATA_SCHEMA,
  VERIFY_DATA_SCHEMA,
};
