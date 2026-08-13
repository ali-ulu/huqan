'use strict';

const VERIFY_STATUS = ['dogrulandi', 'celiski', 'bilinmiyor'];
const CONTRADICTION_REASONS = [
  'negated_statement_conflicts_with_known_fact',
  'opposite_predicate_conflict',
  'type_mismatch_with_known_types',
  'negated_statement_conflicts_with_type_chain',
];

const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['direct_edge', 'path', 'contradiction', 'partial_match', 'hypothesis'],
    },
    text: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    nodes: { type: 'array', items: { type: 'string' } },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          relation: { type: 'string' },
        },
        required: ['from', 'to', 'relation'],
        additionalProperties: false,
      },
    },
  },
  required: ['kind', 'text', 'confidence', 'nodes', 'edges'],
  additionalProperties: false,
};

const RISK_SCHEMA = {
  type: 'object',
  properties: {
    manipulation: { type: 'boolean' },
    score: { type: 'number', minimum: 0, maximum: 1 },
    blocked: { type: 'boolean' },
    downgraded: { type: 'boolean' },
    labels: { type: 'array', items: { type: 'string' } },
    reasons: { type: 'array', items: { type: 'string' } },
    extractedStatement: { type: 'string' },
    source: { type: 'string' },
  },
  required: ['manipulation', 'score', 'labels', 'reasons', 'blocked', 'downgraded'],
  additionalProperties: true,
};

const EDGE_REF_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    relation: { type: 'string' },
  },
  required: ['from', 'to', 'relation'],
  additionalProperties: false,
};

const PATH_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
};

const META_SCHEMA = {
  type: 'object',
  properties: {
    contractVersion: { type: 'string' },
    backend: { type: 'string' },
    paranoidMode: { type: 'boolean' },
    source: { type: 'string' },
    learnedAt: { type: 'string' },
    mode: { type: 'string' },
    inferredBy: { type: 'string' },
  },
  required: ['contractVersion', 'backend', 'paranoidMode'],
  additionalProperties: true,
};

function buildEnvelopeSchema(dataSchema) {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      type: { type: 'string' },
      data: { anyOf: [{ type: 'null' }, dataSchema] },
      evidence: { type: 'array', items: EVIDENCE_SCHEMA },
      error: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['code', 'message'],
            additionalProperties: false,
          },
        ],
      },
      meta: META_SCHEMA,
    },
    required: ['ok', 'type', 'data', 'evidence', 'error', 'meta'],
    additionalProperties: true,
  };
}

module.exports = {
  VERIFY_STATUS,
  CONTRADICTION_REASONS,
  EVIDENCE_SCHEMA,
  RISK_SCHEMA,
  EDGE_REF_SCHEMA,
  PATH_SCHEMA,
  META_SCHEMA,
  buildEnvelopeSchema,
};
