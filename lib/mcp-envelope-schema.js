'use strict';

const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const {
  CANONICAL_VERIFY_STATUSES,
  LEGACY_VERIFY_STATUSES,
} = require('./verify-status-vocabulary');

/**
 * The verify-status enum this server advertises, and therefore emits.
 *
 * HUQAN is an English-positioned product whose HTTP API already answers
 * `verified` / `contradicted` / `unknown`. MCP was the last surface still
 * answering `dogrulandi` / `celiski` / `bilinmiyor`, which every Claude and
 * Cursor user saw, because this enum is an advertised output schema and
 * lib/mcp/response-builders.js projected the envelope back to match it.
 *
 * Flipping it is the compatibility gate
 * docs/verify-status-vocabulary-migration.md reserved, in the shape RFC-001's
 * M1-M4 pattern uses: canonical by default, the legacy spelling retained
 * behind an opt-in, and the change announced rather than silent.
 *
 * HUQAN_MCP_LEGACY_VERIFY_STATUS=1 restores the legacy enum. It moves the
 * advertised schema and the emitted payload together, never one without the
 * other -- a client that reads the schema it is given is correct in both
 * modes, and the mode a server is in is answerable from tools/list alone.
 *
 * Acceptance is unaffected and stays permanent: lib/verify-status-vocabulary.js
 * reads both spellings whichever mode this is in.
 */
const MCP_LEGACY_VERIFY_STATUS_ENV = 'MCP_LEGACY_VERIFY_STATUS';

function usesLegacyVerifyStatus() {
  const raw = readCompatibleEnvironmentVariable(MCP_LEGACY_VERIFY_STATUS_ENV);
  if (raw === undefined || raw === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

// Resolved once: an MCP server is a process, and a schema that changed shape
// mid-session would contradict the tools/list its client already read.
const VERIFY_STATUS = usesLegacyVerifyStatus()
  ? [...LEGACY_VERIFY_STATUSES]
  : [...CANONICAL_VERIFY_STATUSES];
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
      workflowId: { type: 'string' },
      version: { type: 'string' },
      status: { type: 'string' },
      type: { type: 'string' },
      data: { anyOf: [{ type: 'null' }, dataSchema] },
      evidence: { type: 'array', items: EVIDENCE_SCHEMA },
      confidence: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
      policy: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      approval: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      canonicalWrite: { type: 'boolean' },
      candidateId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      provenance: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      audit: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      receipt: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      trace: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      receiptId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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
    required: ['ok', 'workflowId', 'version', 'status', 'type', 'data', 'evidence', 'confidence', 'policy', 'approval', 'canonicalWrite', 'candidateId', 'provenance', 'audit', 'receipt', 'trace', 'receiptId', 'error', 'meta'],
    additionalProperties: true,
  };
}

module.exports = {
  VERIFY_STATUS,
  MCP_LEGACY_VERIFY_STATUS_ENV,
  usesLegacyVerifyStatus,
  CONTRADICTION_REASONS,
  EVIDENCE_SCHEMA,
  RISK_SCHEMA,
  EDGE_REF_SCHEMA,
  PATH_SCHEMA,
  META_SCHEMA,
  buildEnvelopeSchema,
};
