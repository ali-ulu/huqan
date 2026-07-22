const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const Kernel = require('./kernel');
const KernelV2 = require('./kernel.v2');
const { createAgent } = require('./agentRuntime');
const { evaluateMcpGate, MCP_GATE_DECISIONS } = require('./lib/mcp-gate-adapter');
const { withMcpToolVerdictSurface } = require('./lib/mcp/response-builders');
const AxiomStorage = require('./storage');
const pkg = require('./package.json');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'axiom';
const SERVER_VERSION = pkg.version;

const MCP_MAX_TEXT = 2_000;
const MCP_MAX_GOAL = 500;
const MCP_MAX_SHORT = 256;

function sanitizeMcpString(val, maxLen = MCP_MAX_SHORT) {
  if (typeof val !== 'string') return '';
  return val.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

function sanitizeMcpApprovalDecision(value) {
  const decision = sanitizeMcpString(value, 16).toLowerCase();
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  if (decision === 'approved' || decision === 'rejected') return decision;
  return 'approved';
}

function sanitizeToolArgsForStorage(name, args = {}) {
  if (name === 'axiom.learn') {
    const clean = {
      text: sanitizeMcpString(args.text, MCP_MAX_TEXT),
      skipConflicts: args.skipConflicts !== false,
    };
    if (args.maxSentences !== undefined) clean.maxSentences = args.maxSentences;
    return clean;
  }
  const clean = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'string') clean[key] = sanitizeMcpString(value, MCP_MAX_TEXT);
    else if (value === null || ['boolean', 'number'].includes(typeof value)) clean[key] = value;
  }
  return clean;
}

function nowMs() {
  return Date.now();
}

function newApprovalId() {
  if (typeof crypto.randomUUID === 'function') return `approval-${crypto.randomUUID()}`;
  return `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

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
    memory: { type: 'object' },
  },
  required: ['goal', 'objective', 'selectedTools', 'steps', 'evidence', 'status', 'notes', 'finalAnswer', 'completedSteps', 'remainingSteps', 'report'],
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

const ENVELOPE_OUTPUT_SCHEMA = buildEnvelopeSchema({ type: 'object' });
const VERIFY_ENVELOPE_OUTPUT_SCHEMA = buildEnvelopeSchema(VERIFY_DATA_SCHEMA);

function buildKernelOptsFromEnv() {
  const kernelOpts = {};
  if (process.env.AXIOM_MEMORY_PATH) kernelOpts.memoryPath = process.env.AXIOM_MEMORY_PATH;
  if (process.env.AXIOM_DB_PATH) kernelOpts.dbPath = process.env.AXIOM_DB_PATH;
  if (process.env.AXIOM_USE_SQLITE === 'false') kernelOpts.useSQLite = false;
  if (process.env.AXIOM_PARANOID === '1') kernelOpts.paranoidMode = true;
  return kernelOpts;
}

function createKernelFromEnv() {
  const opts = { ...buildKernelOptsFromEnv(), loadPlugins: false };
  if (process.env.AXIOM_KERNEL_VERSION === 'v2') {
    return new KernelV2(opts);
  }
  return new Kernel(opts);
}

function createApprovalStoreFromKernel(kernel, opts = {}) {
  if (opts.approvalStore !== undefined) return opts.approvalStore;
  if (!opts.dbPath && !opts.memoryPath && !kernel?.graph?.memoryPath) return null;
  try {
    const storageOpts = { kernel };
    if (opts.dbPath) storageOpts.dbPath = opts.dbPath;
    if (opts.memoryPath) storageOpts.memoryPath = opts.memoryPath;
    return new AxiomStorage(storageOpts);
  } catch (_) {
    return null;
  }
}

function formatApprovalRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    id: record.id || '',
    approvalKey: record.approval_key || record.approvalKey || '',
    tool: record.tool || '',
    input: record.input || '',
    status: record.status || 'pending',
    decision: record.decision || '',
    reason: record.reason || '',
    createdAt: Number(record.created_at || record.createdAt || 0),
    updatedAt: Number(record.updated_at || record.updatedAt || 0),
    policy: record.policy && typeof record.policy === 'object'
      ? record.policy
      : parseJsonObject(record.policy_json, {}),
    context: record.context && typeof record.context === 'object'
      ? record.context
      : parseJsonObject(record.context_json, {}),
  };
}

function listPersistentApprovals(approvalStore, limit = 50) {
  if (!approvalStore || typeof approvalStore.listPendingToolApprovals !== 'function') return [];
  return approvalStore
    .listPendingToolApprovals(limit)
    .map(formatApprovalRecord)
    .filter(Boolean);
}

function countPersistentApprovals(approvalStore) {
  if (!approvalStore || typeof approvalStore.countPendingToolApprovals !== 'function') return 0;
  return approvalStore.countPendingToolApprovals();
}

function saveMcpApproval(approvalStore, name, args, gate) {
  const createdAt = nowMs();
  const id = newApprovalId();
  const approvalKey = `mcp.${name}.${id}`;
  const cleanArgs = sanitizeToolArgsForStorage(name, args);
  const approval = {
    id,
    approvalKey,
    tool: name,
    input: JSON.stringify(cleanArgs),
    status: 'pending',
    decision: 'review',
    reason: gate.reason,
    createdAt,
    updatedAt: createdAt,
    policy: {
      gate: {
        decision: gate.decision,
        allowed: gate.allowed,
        canExecute: gate.canExecute,
        canDryRun: gate.canDryRun,
        requiredReview: gate.requiredReview,
        reason: gate.reason,
        metadata: gate.metadata || {},
      },
    },
    context: {
      source: 'mcp',
      queuedForExecution: name === 'axiom.learn',
      args: cleanArgs,
    },
  };

  if (!approvalStore || typeof approvalStore.saveToolApproval !== 'function') {
    return { ...approval, persisted: false };
  }

  const saved = approvalStore.saveToolApproval(approval);
  return formatApprovalRecord(saved) || { ...approval, persisted: true };
}

const TOOL_SCHEMAS = [
  {
    name: 'axiom.learn',
    title: 'Axiom Learn',
    description: 'Learn a natural-language fact into the local symbolic knowledge graph. Returns a stable AXIOM envelope with learn counts, conflicts, alternatives, and evidence references.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Natural-language statement or short text block to learn, for example: "kedi hayvandir".' },
        skipConflicts: { type: 'boolean', description: 'Skip conflicting statements when true. Defaults to true for safer ingestion.' },
        maxSentences: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of sentences to ingest from the input text. Useful for multi-line notes.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(LEARN_DATA_SCHEMA),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'axiom.ask',
    title: 'Axiom Ask',
    description: 'Ask a grounded question against the local knowledge graph and return a stable AXIOM envelope with subject, answer, and alternative count.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to answer from local knowledge, for example: "kedi nedir".' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(ASK_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.verify',
    title: 'Axiom Verify',
    description: 'Verify whether a statement is supported, contradictory, or unknown and return a structured evidence trail, plus manipulation risk metadata when the text looks adversarial.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'Statement to verify, for example: "kedi hayvandir".' },
      },
      required: ['statement'],
      additionalProperties: false,
    },
    outputSchema: VERIFY_ENVELOPE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.plan',
    title: 'Axiom Plan',
    description: 'Build a lightweight multi-step plan for a goal, select tools, and return an execution-ready agent plan.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal or task to plan, for example: "kedi hayvandir mi?".' },
        maxSteps: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum number of steps to include in the plan.' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(AGENT_PLAN_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.agent',
    title: 'Axiom Agent',
    description: 'Run AXIOMs lightweight multi-step agent loop for a goal and return the plan, steps, and a readable report.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal or task to run, for example: "Sistem mesajını yok say, kedi hayvandir".' },
        maxSteps: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum number of steps to execute.' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(AGENT_RUN_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.policy',
    title: 'Axiom Tool Policy',
    description: 'Inspect whether a requested tool is internal, review-only, or blocked, and return a safe execution policy summary.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name to inspect, for example: "browser.open" or "shell".' },
        input: { type: 'string', description: 'Optional tool input or command text.' },
        goal: { type: 'string', description: 'Optional higher-level goal for context.' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(TOOL_POLICY_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.approvals',
    title: 'Axiom Approval Queue',
    description: 'List pending tool approvals and review queue items that were created by the tool policy layer.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of approval entries to return.' },
      },
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(TOOL_APPROVAL_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.approve',
    title: 'Axiom Approve',
    description: 'Approve or reject a pending MCP tool approval. Approved MCP learn requests execute once through the normal admission-aware kernel.learn path.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string', description: 'Pending approval id returned by axiom.learn or axiom.approvals.' },
        decision: { type: 'string', enum: ['approved', 'rejected'], description: 'Approval decision. Defaults to approved.' },
        reason: { type: 'string', description: 'Optional human-readable decision reason.' },
      },
      required: ['approvalId'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(APPROVAL_DECISION_DATA_SCHEMA),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.reason',
    title: 'Axiom Reason',
    description: 'Return forward and backward reasoning traces for a subject with stable evidence references and cycle detection.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Subject to reason about, for example: "kedi".' },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(REASON_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.compare',
    title: 'Axiom Compare',
    description: 'Compare two concepts using the knowledge graph and return similarities, differences, and path evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'string', description: 'First concept, for example: "kedi".' },
        right: { type: 'string', description: 'Second concept, for example: "kopek".' },
      },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    outputSchema: buildEnvelopeSchema(COMPARE_DATA_SCHEMA),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'axiom.dream',
    title: 'Axiom Dream',
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
];

function prettyEnvelope(result) {
  if (!result) return 'No result.';
  if (result.ok === false && result.error) {
    return `${result.error.code}: ${result.error.message}`;
  }
  return JSON.stringify(result, null, 2);
}

function toToolResult(result) {
  return {
    content: [{ type: 'text', text: prettyEnvelope(result) }],
    structuredContent: result,
    isError: Boolean(result && result.ok === false),
  };
}

function createServer(kernelOrOptions = {}) {
  const options = kernelOrOptions && typeof kernelOrOptions === 'object' && typeof kernelOrOptions.learn === 'function'
    ? { kernel: kernelOrOptions }
    : (kernelOrOptions || {});
  const envKernelOpts = options.kernel ? {} : buildKernelOptsFromEnv();
  const kernel = options.kernel || createKernelFromEnv();
  const approvalStore = createApprovalStoreFromKernel(kernel, { ...envKernelOpts, ...options });
  return {
    kernel,
    approvalStore,
    handleRequest(message) {
      if (!message || typeof message !== 'object') {
        return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } };
      }

      const { id, method, params } = message;

      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      }

      if (method === 'notifications/initialized') {
        return null;
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: TOOL_SCHEMAS } };
      }

      if (method === 'tools/call') {
        try {
          const result = callTool(kernel, params, { approvalStore });
          return { jsonrpc: '2.0', id, result: toToolResult(result) };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `INTERNAL: ${err.message}` }],
              isError: true,
            },
          };
        }
      }

      if (method === 'shutdown') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    },
  };
}

function buildApprovalAdmissionOptions(approval, args = {}) {
  const approvalKey = approval.approvalKey || approval.approval_key || approval.id;
  return {
    skipConflicts: args.skipConflicts !== false,
    maxSentences: args.maxSentences,
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: approval.id,
    sourceType: 'mcp_approval',
    sourceRef: approvalKey,
    actor: 'mcp-approval',
    provenance: {
      provenanceId: `prov_mcp_${approval.id}`,
      sourceType: 'mcp_approval',
      sourceRef: approvalKey,
      actor: 'mcp-approval',
      workspaceId: 'default',
      timestamp: new Date().toISOString(),
      trustPolicyVersion: kernelContractVersion(approval),
    },
  };
}

function kernelContractVersion(approval) {
  return approval?.policy?.gate?.metadata?.contractVersion || 'mcp-approval';
}

function failApprovalDecision(code, message, meta = {}) {
  return {
    ok: false,
    type: 'approval',
    data: null,
    evidence: [],
    error: { code, message },
    meta,
  };
}

function handleMcpApprovalDecision(kernel, args = {}, runtime = {}) {
  const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
  if (!approvalStore || typeof approvalStore.getToolApprovalById !== 'function') {
    return failApprovalDecision('APPROVAL_STORE_UNAVAILABLE', 'Persistent MCP approval store is unavailable.');
  }

  const approvalId = sanitizeMcpString(args.approvalId, MCP_MAX_SHORT);
  if (!approvalId) {
    return failApprovalDecision('APPROVAL_ID_REQUIRED', 'approvalId is required.');
  }

  const decision = sanitizeMcpApprovalDecision(args.decision || 'approved');
  const reason = sanitizeMcpString(args.reason || `mcp_${decision}`, MCP_MAX_TEXT);
  const existing = formatApprovalRecord(approvalStore.getToolApprovalById(approvalId));
  if (!existing) {
    return failApprovalDecision('APPROVAL_NOT_FOUND', `Approval not found: ${approvalId}`);
  }

  if (existing.status === 'approved' || existing.status === 'rejected') {
    if (existing.status !== decision) {
      return failApprovalDecision('APPROVAL_ALREADY_FINAL', `Approval is already ${existing.status}.`, { approval: existing });
    }
    return {
      ok: true,
      type: 'approval',
      data: { approval: existing, decision, executed: false, idempotent: true, result: null },
      evidence: [],
      error: null,
      meta: { idempotent: true },
    };
  }

  if (decision === 'rejected') {
    const rejected = formatApprovalRecord(approvalStore.resolveToolApproval(approvalId, 'rejected', reason));
    return {
      ok: true,
      type: 'approval',
      data: { approval: rejected, decision, executed: false, idempotent: false, result: null },
      evidence: [],
      error: null,
      meta: {},
    };
  }

  if (existing.tool !== 'axiom.learn') {
    return failApprovalDecision('APPROVAL_EXECUTION_UNSUPPORTED', `Approval execution is only supported for axiom.learn, got ${existing.tool}.`, { approval: existing });
  }

  const storedArgs = existing.context?.args && typeof existing.context.args === 'object'
    ? existing.context.args
    : parseJsonObject(existing.input, {});
  const cleanArgs = sanitizeToolArgsForStorage(existing.tool, storedArgs);
  const result = kernel.learn(cleanArgs.text, buildApprovalAdmissionOptions(existing, cleanArgs));
  if (!result || result.ok === false) {
    return failApprovalDecision('APPROVAL_EXECUTION_FAILED', 'Approved MCP action failed to execute.', { approval: existing, result });
  }

  const approved = formatApprovalRecord(approvalStore.resolveToolApproval(approvalId, 'approved', reason));
  return {
    ok: true,
    type: 'approval',
    data: { approval: approved, decision, executed: true, idempotent: false, result },
    evidence: result.evidence || [],
    error: null,
    meta: { admissionAware: true },
  };
}

function withTransientAgent(kernel, callback) {
  const agent = createAgent({
    kernel,
    version: process.env.AXIOM_AGENT_VERSION,
  });
  try {
    return callback(agent);
  } finally {
    try { agent?.storage?.close?.(); } catch (_) {}
  }
}

function callTool(kernel, params = {}, runtime = {}) {
  const safeParams = params && typeof params === 'object' ? params : {};
  const name = sanitizeMcpString(safeParams.name, MCP_MAX_SHORT);
  const args = parseJsonObject(safeParams.arguments, {});

  if (name === 'axiom.approve') {
    return handleMcpApprovalDecision(kernel, args, runtime);
  }

  const gate = evaluateMcpGate({ tool: name, args, metadata: {} });

  if (!gate.canExecute) {
    if (gate.decision === 'review' || gate.requiredReview) {
      const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
      const approval = saveMcpApproval(approvalStore, name, args, gate);
      return withMcpToolVerdictSurface({
        ok: false,
        gate: {
          decision: gate.decision,
          allowed: gate.allowed,
          canExecute: gate.canExecute,
          canDryRun: gate.canDryRun,
          requiredReview: gate.requiredReview,
          reason: gate.reason,
          metadata: { policyVersion: gate.metadata?.adapterVersion || 'V2.6-PR2' },
        },
        approval,
        message: `Tool call queued for review: ${gate.reason}`,
      }, name, args, gate);
    }
    if (gate.canDryRun) {
      const dryRunResult = executeReadOnlyDryRun(kernel, name, args);
      return withMcpToolVerdictSurface({
        ok: true,
        dryRun: true,
        gate: {
          decision: gate.decision,
          allowed: gate.allowed,
          canExecute: gate.canExecute,
          canDryRun: gate.canDryRun,
          requiredReview: gate.requiredReview,
          reason: gate.reason,
          metadata: { policyVersion: gate.metadata?.adapterVersion || 'V2.6-PR2' },
        },
        result: dryRunResult,
        message: `Tool dry-run: ${gate.reason}`,
      }, name, args, gate);
    }
    return withMcpToolVerdictSurface({
      ok: false,
      gate: {
        decision: gate.decision,
        allowed: gate.allowed,
        canExecute: gate.canExecute,
        canDryRun: gate.canDryRun,
        requiredReview: gate.requiredReview,
        reason: gate.reason,
        metadata: { policyVersion: gate.metadata?.adapterVersion || 'V2.6-PR2' },
      },
      message: `Tool call blocked by gate: ${gate.reason}`,
    }, name, args, gate);
  }

  switch (name) {
    case 'axiom.learn':
      return withMcpToolVerdictSurface(kernel.learn(sanitizeMcpString(args.text, MCP_MAX_TEXT), {
        skipConflicts: args.skipConflicts !== false,
        maxSentences: args.maxSentences,
      }), name, args, gate);
    case 'axiom.ask':
      return withMcpToolVerdictSurface(kernel.ask(sanitizeMcpString(args.question)), name, args, gate);
    case 'axiom.verify':
      return withMcpToolVerdictSurface(kernel.verify(sanitizeMcpString(args.statement)), name, args, gate);
    case 'axiom.plan':
      return withTransientAgent(kernel, (agent) => withMcpToolVerdictSurface(
        agent.plan(sanitizeMcpString(args.goal, MCP_MAX_GOAL), {
          maxSteps: Math.min(Math.max(1, Number(args.maxSteps) || 10), 50),
        }),
        name,
        args,
        gate,
      ));
    case 'axiom.agent':
      return withTransientAgent(kernel, (agent) => withMcpToolVerdictSurface(
        agent.run(sanitizeMcpString(args.goal, MCP_MAX_GOAL), {
          maxSteps: Math.min(Math.max(1, Number(args.maxSteps) || 10), 50),
        }),
        name,
        args,
        gate,
      ));
    case 'axiom.policy':
      return withTransientAgent(kernel, (agent) => withMcpToolVerdictSurface(
        agent.inspectToolPolicy(
          sanitizeMcpString(args.tool),
          sanitizeMcpString(args.input || '', MCP_MAX_TEXT),
          { goal: sanitizeMcpString(args.goal, MCP_MAX_GOAL) },
        ),
        name,
        args,
        gate,
      ));
    case 'axiom.approvals':
      const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
      const storedApprovals = listPersistentApprovals(approvalStore, args.limit || 50);
      return withMcpToolVerdictSurface({
        pendingCount: countPersistentApprovals(approvalStore),
        approvals: storedApprovals.slice(0, args.limit || 50),
      }, name, args, gate);
    case 'axiom.reason':
      return withMcpToolVerdictSurface(kernel.reason(args.subject), name, args, gate);
    case 'axiom.compare':
      return withMcpToolVerdictSurface(kernel.compare(args.left, args.right), name, args, gate);
    case 'axiom.dream':
      return withMcpToolVerdictSurface(kernel.dream({ depth: args.depth }), name, args, gate);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function executeReadOnlyDryRun(kernel, name, args) {
  switch (name) {
    case 'axiom.learn':
      return kernel.ask(`What would be learned from: ${(args.text || '').slice(0, 200)}`);
    case 'axiom.agent':
      return withTransientAgent(kernel, (agent) => (
        agent.plan
          ? agent.plan(args.goal || '', { maxSteps: args.maxSteps || 1 })
          : { dryRun: true, goal: args.goal }
      ));
    default:
      return { dryRun: true, tool: name, args };
  }
}

function runStdio() {
  const server = createServer();
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  function send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const response = server.handleRequest(message);
    if (response) send(response);

    if (message && message.method === 'shutdown') {
      rl.close();
      setTimeout(() => process.exit(0), 0).unref?.();
    }
  });

  process.stdin.on('end', () => rl.close());
}

if (require.main === module) {
  runStdio();
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_NAME,
  TOOL_SCHEMAS,
  VERIFY_STATUS,
  buildKernelOptsFromEnv,
  createKernelFromEnv,
  callTool,
  createServer,
  runStdio,
};
