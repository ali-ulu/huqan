'use strict';

// #2172: data schemas for agent steps, plans, runs and continuations.

const { EVIDENCE_SCHEMA } = require('./mcp-envelope-schema');

const AGENT_STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    action: { type: 'string' },
    tool: { type: 'string' },
    input: {},
    rationale: { type: 'string' },
    status: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['id', 'action', 'tool', 'rationale', 'status', 'summary'],
  additionalProperties: true,
};

const AGENT_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    objective: { type: 'string' },
    shortGoal: { type: 'string' },
    steps: { type: 'array', items: AGENT_STEP_SCHEMA },
    selectedTools: { type: 'array', items: { type: 'string' } },
    maxSteps: { type: 'integer', minimum: 1 },
    status: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    policy: { type: 'object' },
    memory: { type: 'object' },
    rationale: { type: 'string' },
  },
  required: ['goal', 'objective', 'shortGoal', 'steps', 'selectedTools', 'maxSteps', 'status', 'confidence', 'rationale'],
  additionalProperties: true,
};

const AGENT_RUN_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    objective: { type: 'string' },
    plan: { type: 'object' },
    selectedTools: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: AGENT_STEP_SCHEMA },
    evidence: { type: 'array', items: EVIDENCE_SCHEMA },
    status: { type: 'string' },
    notes: { type: 'array', items: { type: 'object' } },
    queuedSteps: { type: 'array', items: AGENT_STEP_SCHEMA },
    finalAnswer: { type: 'string' },
    completedSteps: { type: 'integer', minimum: 0 },
    remainingSteps: { type: 'integer', minimum: 0 },
    iteration: { type: 'integer', minimum: 0 },
    budgetRemaining: { type: 'integer', minimum: 0 },
    report: { type: 'string' },
    resumed: { type: 'boolean' },
    resumedFrom: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    checkpointId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    resumeToken: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    pauseReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    workspaceId: { type: 'string' },
    nextAction: { anyOf: [{ type: 'object' }, { type: 'string' }, { type: 'null' }] },
    lastAction: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    progress: { type: 'object' },
    memory: { type: 'object' },
  },
  required: ['goal', 'objective', 'selectedTools', 'steps', 'evidence', 'status', 'notes', 'finalAnswer', 'completedSteps', 'remainingSteps', 'report'],
  additionalProperties: true,
};

const AGENT_CONTINUATION_SCHEMA = {
  type: 'object',
  properties: {
    planId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    planVersion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    runId: { type: 'string' },
    checkpointId: { type: 'string' },
    resumeToken: { type: 'string' },
    workspaceId: { type: 'string' },
    status: { type: 'string' },
    pauseReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nextAction: { anyOf: [{ type: 'object' }, { type: 'string' }, { type: 'null' }] },
    stepTrace: { type: 'array', items: AGENT_STEP_SCHEMA },
    approvalReferences: { type: 'array', items: { type: 'object', additionalProperties: true } },
    evidence: { type: 'array', items: EVIDENCE_SCHEMA },
    receiptId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    continuationMode: { type: 'string', enum: ['resume', 'repair'] },
    repairReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    continuationDecision: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    repairDecision: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'planId', 'planVersion', 'runId', 'checkpointId', 'resumeToken', 'workspaceId',
    'status', 'pauseReason', 'nextAction', 'stepTrace', 'approvalReferences', 'evidence', 'receiptId',
  ],
  additionalProperties: true,
};

module.exports = {
  AGENT_CONTINUATION_SCHEMA,
  AGENT_PLAN_SCHEMA,
  AGENT_RUN_SCHEMA,
  AGENT_STEP_SCHEMA,
};
