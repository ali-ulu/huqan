'use strict';

const {
  VERIFY_STATUS,
  CONTRADICTION_REASONS,
  EVIDENCE_SCHEMA,
  RISK_SCHEMA,
  EDGE_REF_SCHEMA,
  PATH_SCHEMA,
  buildEnvelopeSchema,
} = require('./mcp-envelope-schema');

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
    repairDecision: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'planId', 'planVersion', 'runId', 'checkpointId', 'resumeToken', 'workspaceId',
    'status', 'pauseReason', 'nextAction', 'stepTrace', 'approvalReferences', 'evidence', 'receiptId',
  ],
  additionalProperties: true,
};

const TOOL_POLICY_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    input: { type: 'string' },
    category: { type: 'string', enum: ['internal', 'external'] },
    action: { type: 'string', enum: ['allow', 'review', 'block'] },
    approval: { type: 'string', enum: ['auto', 'review', 'blocked'] },
    blocked: { type: 'boolean' },
    requiresApproval: { type: 'boolean' },
    review: { type: 'boolean' },
    riskScore: { type: 'integer', minimum: 0, maximum: 100 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    labels: { type: 'array', items: { type: 'string' } },
    reasons: { type: 'array', items: { type: 'string' } },
    suggestedNextStep: { type: 'string' },
    source: { type: 'string' },
    context: { type: 'object' },
    approvalId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    approvalStatus: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['tool', 'category', 'action', 'approval', 'blocked', 'requiresApproval', 'labels', 'reasons'],
  additionalProperties: true,
};

const TOOL_APPROVAL_SCHEMA = {
  type: 'object',
  properties: {
    pendingCount: { type: 'integer', minimum: 0 },
    unresolvedCount: { type: 'integer', minimum: 0 },
    approvals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          approvalKey: { type: 'string' },
          tool: { type: 'string' },
          input: { type: 'string' },
          status: { type: 'string' },
          decision: { type: 'string' },
          reason: { type: 'string' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
          policy: { type: 'object' },
          context: { type: 'object' },
        },
        required: ['id', 'approvalKey', 'tool', 'status', 'decision', 'reason', 'createdAt', 'updatedAt'],
        additionalProperties: true,
      },
    },
  },
  required: ['pendingCount', 'approvals'],
  additionalProperties: true,
};

const APPROVAL_DECISION_DATA_SCHEMA = {
  type: 'object',
  properties: {
    approval: { type: 'object' },
    decision: { type: 'string' },
    executed: { type: 'boolean' },
    idempotent: { type: 'boolean' },
    result: { type: 'object' },
  },
  required: ['approval', 'decision', 'executed', 'idempotent'],
  additionalProperties: true,
};

const ADVOCATE_DATA_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    counterArguments: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
};

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

const INGEST_PREVIEW_DATA_SCHEMA = {
  type: 'object',
  properties: {
    workflowId: { type: 'string', const: 'ingest-preview' },
    status: { type: 'string', const: 'completed' },
    sourceManifest: {
      type: 'object',
      properties: {
        version: { type: 'string', const: 'huqan.ingest-source-manifest.v1' },
        workspaceId: { type: 'string', const: 'default' },
        sourceType: { type: 'string', enum: ['manual', 'decision'] },
        sourceRef: { type: 'string' },
        sourceDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        idempotencyKey: { type: 'string' },
        itemCount: { type: 'integer', const: 1 },
      },
      required: ['version', 'workspaceId', 'sourceType', 'sourceRef', 'sourceDigest', 'idempotencyKey', 'itemCount'],
      additionalProperties: false,
    },
    review: {
      type: 'object',
      properties: {
        required: { type: 'boolean', const: true },
        canonicalWrite: { type: 'boolean', const: false },
        nextAction: { type: 'string', const: 'submit_ingest_execute' },
        executeRoute: { type: 'string', const: '/api/v2/ingest/execute' },
      },
      required: ['required', 'canonicalWrite', 'nextAction', 'executeRoute'],
      additionalProperties: false,
    },
    progress: {
      type: 'object',
      properties: {
        completed: { type: 'integer', const: 0 },
        total: { type: 'integer', const: 1 },
        hasMore: { type: 'boolean', const: false },
      },
      required: ['completed', 'total', 'hasMore'],
      additionalProperties: false,
    },
  },
  required: ['workflowId', 'status', 'sourceManifest', 'review', 'progress'],
  additionalProperties: false,
};

// Mirrors buildIngestWorkflowRun(), which is also what GET /api/v2/ingest/runs/{id}
// returns, so an MCP client and an HTTP client read the same run projection.
// retry/resume are reported as explicit allowed+reason pairs rather than being
// omitted: "not retryable, and here is why" is a contract a client can act on,
// while a missing field is not.
const INGEST_EXECUTE_DATA_SCHEMA = {
  type: 'object',
  properties: {
    approval: { type: 'object', additionalProperties: true },
    approvalId: { type: 'string' },
    statusRoute: { type: 'string' },
    queuedForExecution: { type: 'boolean' },
    result: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    receipt: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    refs: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
  },
  required: ['approvalId', 'statusRoute', 'queuedForExecution'],
  additionalProperties: true,
};

const INGEST_RUN_DATA_SCHEMA = {
  type: 'object',
  properties: {
    workflowId: { type: 'string', const: 'ingest-run-detail' },
    runId: { type: 'string' },
    status: { type: 'string', enum: ['review_required', 'queued', 'completed', 'blocked', 'failed'] },
    phase: { type: 'string', enum: ['awaiting_review', 'executing', 'finalized', 'rejected', 'reconciliation_required'] },
    sourceManifest: { type: 'object', additionalProperties: true },
    progress: {
      type: 'object',
      properties: {
        completed: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 0 },
        hasMore: { type: 'boolean' },
      },
      required: ['completed', 'total', 'hasMore'],
      additionalProperties: false,
    },
    retry: {
      type: 'object',
      properties: { allowed: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['allowed', 'reason'],
      additionalProperties: false,
    },
    resume: {
      type: 'object',
      properties: { allowed: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['allowed', 'reason'],
      additionalProperties: false,
    },
    nextAction: { type: ['string', 'null'] },
    approvalId: { type: 'string' },
    receiptId: { type: ['string', 'null'] },
    workspaceId: { type: 'string' },
  },
  required: ['workflowId', 'runId', 'status', 'phase', 'progress', 'retry', 'resume', 'approvalId'],
  additionalProperties: true,
};

const ENVELOPE_OUTPUT_SCHEMA = buildEnvelopeSchema({ type: 'object' });
const VERIFY_ENVELOPE_OUTPUT_SCHEMA = buildEnvelopeSchema(VERIFY_DATA_SCHEMA);

module.exports = {
  LEARN_DATA_SCHEMA,
  ASK_DATA_SCHEMA,
  REASON_DATA_SCHEMA,
  COMPARE_DATA_SCHEMA,
  DREAM_DATA_SCHEMA,
  AGENT_STEP_SCHEMA,
  AGENT_PLAN_SCHEMA,
  AGENT_RUN_SCHEMA,
  AGENT_CONTINUATION_SCHEMA,
  TOOL_POLICY_SCHEMA,
  TOOL_APPROVAL_SCHEMA,
  APPROVAL_DECISION_DATA_SCHEMA,
  ADVOCATE_DATA_SCHEMA,
  MEMORY_SEARCH_DATA_SCHEMA,
  TRUST_RECEIPT_DATA_SCHEMA,
  VERIFY_DATA_SCHEMA,
  INGEST_PREVIEW_DATA_SCHEMA,
  INGEST_EXECUTE_DATA_SCHEMA,
  INGEST_RUN_DATA_SCHEMA,
  ENVELOPE_OUTPUT_SCHEMA,
  VERIFY_ENVELOPE_OUTPUT_SCHEMA,
};
