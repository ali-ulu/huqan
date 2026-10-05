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

const EXPERIENCE_READ_DATA_SCHEMA = {
  type: 'object',
  properties: {
    ok: { const: true },
    runId: { type: 'string' },
    workspaceId: { type: 'string' },
    manifest: { type: 'object', additionalProperties: true },
    events: { type: 'array', items: { type: 'object', additionalProperties: true } },
    hash: { type: 'string', minLength: 64, maxLength: 64 },
  },
  required: ['ok', 'runId', 'workspaceId', 'manifest', 'events', 'hash'],
  additionalProperties: false,
};

const EXPERIENCE_LEARN_DATA_SCHEMA = {
  type: 'object',
  properties: {
    ok: { const: true },
    type: { const: 'experience_learning_proposal' },
    runId: { type: 'string' },
    workspaceId: { type: 'string' },
    sourceHash: { type: 'string', minLength: 64, maxLength: 64 },
    baselineSourceHashes: {
      type: 'array',
      items: { type: 'string', minLength: 64, maxLength: 64 },
      maxItems: 32,
    },
    eligibility: { type: 'string' },
    outcomeStatus: { type: 'string' },
    admission: { type: 'object', additionalProperties: true },
    candidate: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    procedure: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    compileCode: { type: 'string' },
    registered: { const: false },
    hash: { type: 'string', minLength: 64, maxLength: 64 },
  },
  required: ['ok', 'runId', 'workspaceId', 'sourceHash', 'eligibility', 'admission', 'registered', 'hash'],
  additionalProperties: false,
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
  EXPERIENCE_READ_DATA_SCHEMA,
  EXPERIENCE_LEARN_DATA_SCHEMA,
  TRUST_RECEIPT_DATA_SCHEMA,
  VERIFY_DATA_SCHEMA,
};
