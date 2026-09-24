'use strict';

// #2172: data schemas for the knowledge tools -- learn, ask, reason,
// compare, dream, fractal learn, self-evolve.

const { EDGE_REF_SCHEMA, PATH_SCHEMA } = require('./mcp-envelope-schema');

const LEARN_DATA_SCHEMA = {
  type: 'object',
  properties: {
    learned: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          subject: { type: 'string' },
          relation: { type: 'string' },
          current: { type: 'string' },
          existing: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          message: { type: 'string' },
        },
        required: ['type', 'subject', 'relation', 'current', 'existing'],
        additionalProperties: true,
      },
    },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          relation: { type: 'string' },
          current: { type: 'string' },
          existing: { type: 'array', items: { type: 'string' } },
        },
        required: ['subject', 'relation', 'current', 'existing'],
        additionalProperties: true,
      },
    },
  },
  required: ['learned', 'skipped', 'conflicts', 'alternatives'],
  additionalProperties: true,
};

const ASK_DATA_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    subject: { type: 'string' },
    unknown: { type: 'boolean' },
    alternatives: { type: 'integer', minimum: 0 },
  },
  required: ['answer', 'subject', 'unknown', 'alternatives'],
  additionalProperties: true,
};

const REASON_DATA_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    answer: { type: 'string' },
    forward: {
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
    backward: {
      type: 'array',
      items: EDGE_REF_SCHEMA,
    },
    cycles: { type: 'array', items: PATH_SCHEMA },
  },
  required: ['subject', 'answer', 'forward', 'backward', 'cycles'],
  additionalProperties: true,
};

const COMPARE_DATA_SCHEMA = {
  type: 'object',
  properties: {
    a: { type: 'string' },
    b: { type: 'string' },
    answer: { type: 'string' },
    common: { type: 'array', items: EDGE_REF_SCHEMA },
    onlyA: { type: 'array', items: EDGE_REF_SCHEMA },
    onlyB: { type: 'array', items: EDGE_REF_SCHEMA },
    paths: { type: 'array', items: PATH_SCHEMA },
  },
  required: ['a', 'b', 'answer', 'common', 'onlyA', 'onlyB', 'paths'],
  additionalProperties: true,
};

const DREAM_DATA_SCHEMA = {
  type: 'object',
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          relation: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          type: { type: 'string' },
          node: { type: 'string' },
          targets: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
    },
    learned: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          relation: { type: 'string' },
        },
        required: ['from', 'to', 'confidence', 'relation'],
        additionalProperties: true,
      },
    },
    cycle: { type: 'integer', minimum: 0 },
  },
  required: ['hypotheses', 'learned', 'cycle'],
  additionalProperties: true,
};

const FRACTAL_LEARN_DATA_SCHEMA = {
  type: 'object',
  properties: {
    rounds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          round: { type: 'integer', minimum: 1 },
          generated: { type: 'integer', minimum: 0 },
          learned: { type: 'integer', minimum: 0 },
          pending: { type: 'integer', minimum: 0 },
          entropyBefore: { type: 'number' },
          entropyAfter: { type: 'number' },
          deltaEntropy: { type: 'number' },
          cycle: { type: ['integer', 'null'] },
        },
        additionalProperties: true,
      },
    },
    totals: {
      type: 'object',
      properties: {
        generated: { type: 'integer', minimum: 0 },
        learned: { type: 'integer', minimum: 0 },
        pending: { type: 'integer', minimum: 0 },
      },
      additionalProperties: true,
    },
    stopReason: { type: 'string', enum: ['exhausted', 'saturated', 'maxRounds'] },
    workspaceId: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
  },
  required: ['rounds', 'totals', 'stopReason'],
  additionalProperties: true,
};

// huqan.self-evolve returns the fractal-learn envelope's data unchanged under
// `fractalLearn`, plus the self-evolution probe's verdict. The verdict is the
// point of the tool: it separates a run that only moved graph content from one
// that moved the thresholds which produce that content.
const SELF_EVOLVE_DATA_SCHEMA = {
  type: 'object',
  properties: {
    workspaceId: { type: 'string' },
    fractalLearn: FRACTAL_LEARN_DATA_SCHEMA,
    selfEvolve: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['native-writes-config', 'native-content-only', 'inactive', 'unmeasured'],
        },
        measurement: { type: ['object', 'null'], additionalProperties: true },
      },
      required: ['verdict'],
      additionalProperties: true,
    },
    params: { type: 'object', additionalProperties: true },
  },
  required: ['fractalLearn', 'selfEvolve'],
  additionalProperties: true,
};

module.exports = {
  ASK_DATA_SCHEMA,
  COMPARE_DATA_SCHEMA,
  DREAM_DATA_SCHEMA,
  FRACTAL_LEARN_DATA_SCHEMA,
  LEARN_DATA_SCHEMA,
  REASON_DATA_SCHEMA,
  SELF_EVOLVE_DATA_SCHEMA,
};
