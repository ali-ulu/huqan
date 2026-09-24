'use strict';

// #2186: MCP tool schemas for reason, compare, dream, fractal learn, self-evolve, advocate and search, in catalog order. lib/mcp-tool-catalog.js
// concatenates the domain arrays back into TOOL_SCHEMAS.

const {
  buildEnvelopeSchema,
} = require('./mcp-envelope-schema');
const {
  REASON_DATA_SCHEMA,
  COMPARE_DATA_SCHEMA,
  DREAM_DATA_SCHEMA,
  FRACTAL_LEARN_DATA_SCHEMA,
  SELF_EVOLVE_DATA_SCHEMA,
  ADVOCATE_DATA_SCHEMA,
  MEMORY_SEARCH_DATA_SCHEMA,
} = require('./mcp-tool-data-schemas');

const REASONING_TOOL_SCHEMAS = [
  {
    name: 'huqan.reason',
    title: 'HUQAN Reason',
    description: 'Return forward and backward reasoning traces for a subject with stable evidence references and cycle detection.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Subject to reason about, for example: "cat".' },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(REASON_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.compare',
    title: 'HUQAN Compare',
    description: 'Compare two concepts using the knowledge graph and return similarities, differences, and path evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'string', description: 'First concept, for example: "cat".' },
        right: { type: 'string', description: 'Second concept, for example: "kopek".' },
      },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(COMPARE_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.dream',
    title: 'HUQAN Dream',
    description: 'Generate hypotheses from the current graph and return ranked speculative links with evidence references.',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional exploration depth. Defaults to 2.' },
      },
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(DREAM_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.fractal-learn',
    title: 'HUQAN Fractal Learn',
    description: 'Run a bounded recursive knowledge-synthesis loop: dream hypotheses, admit them through the mutation gate, and stop when entropy gain saturates. Every write is receipted.',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Dream exploration depth. Defaults to 2.' },
        maxRounds: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum fractal rounds. Defaults to 5.' },
        minScore: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum confidence for a hypothesis to be admitted. Defaults to 0.6.' },
        entropyFloor: { type: 'number', minimum: 0, maximum: 1, description: 'Stop when per-round entropy gain falls below this. Defaults to 0.001.' },
        autoTune: { type: 'boolean', description: 'When true, tighten minScore/entropyFloor one-way (tightening only) after each round using review feedback. Loosening is never automatic.' },
        workspaceId: { type: 'string', maxLength: 128 },
      },
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(FRACTAL_LEARN_DATA_SCHEMA),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'huqan.self-evolve',
    title: 'HUQAN Self Evolve',
    description: 'Run the recursive knowledge-synthesis loop and then a measured self-evolution pass, and report whether the run changed only graph content or also the thresholds that produce it. Every write is receipted and passes the mutation gate.',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Dream exploration depth. Defaults to 2.' },
        maxRounds: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum fractal rounds. Defaults to 5.' },
        minScore: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum confidence for a hypothesis to be admitted. Defaults to 0.6.' },
        entropyFloor: { type: 'number', minimum: 0, maximum: 1, description: 'Stop when per-round entropy gain falls below this. Defaults to 0.001.' },
        autoTune: { type: 'boolean', description: 'When true, tighten minScore/entropyFloor one-way (tightening only) after each round using review feedback. Loosening is never automatic.' },
        workspaceId: { type: 'string', maxLength: 128 },
      },
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(SELF_EVOLVE_DATA_SCHEMA),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'huqan.advocate',
    title: 'HUQAN Advocate',
    description: 'Challenge a claim through the existing devil-advocate capability without mutating canonical state.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', maxLength: 128 },
        claim: { type: 'string', maxLength: 4000 },
      },
      required: ['workspaceId', 'claim'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(ADVOCATE_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'huqan.search',
    title: 'HUQAN Memory Search',
    description: 'Search the existing workspace-scoped memory projection and return provenance references.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', maxLength: 128 },
        query: { type: 'string', maxLength: 300 },
      },
      required: ['workspaceId', 'query'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(MEMORY_SEARCH_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

module.exports = { REASONING_TOOL_SCHEMAS };
