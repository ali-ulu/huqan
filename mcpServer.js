const fs = require('fs');
const readline = require('readline');
const Kernel = require('./kernel');
const KernelV2 = require('./kernel.v2');
const { createAgent } = require('./agentRuntime');
const { evaluateMcpGate, MCP_GATE_DECISIONS } = require('./lib/mcp-gate-adapter');
const pkg = require('./package.json');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'axiom';
const SERVER_VERSION = pkg.version;
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

function createServer() {
  const kernel = createKernelFromEnv();
  return {
    kernel,
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
          const result = callTool(kernel, params);
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

const _pendingApprovals = [];

function callTool(kernel, params = {}) {
  const name = params.name;
  const args = params.arguments || {};

  const gate = evaluateMcpGate({ tool: name, args, metadata: {} });

  if (!gate.canExecute) {
    if (gate.decision === 'review' || gate.requiredReview) {
      const approval = {
        id: `approval-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
        approvalKey: `mcp.${name}`,
        tool: name,
        input: JSON.stringify(args).slice(0, 1000),
        status: 'pending',
        decision: 'review',
        reason: gate.reason,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        policy: {},
        context: {},
      };
      _pendingApprovals.push(approval);
      return {
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
      };
    }
    if (gate.canDryRun) {
      const dryRunResult = executeReadOnlyDryRun(kernel, name, args);
      return {
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
      };
    }
    return {
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
    };
  }

  const agent = createAgent({
    kernel,
    version: process.env.AXIOM_AGENT_VERSION,
  });

  switch (name) {
    case 'axiom.learn':
      return kernel.learn(args.text, {
        skipConflicts: args.skipConflicts !== false,
        maxSentences: args.maxSentences,
      });
    case 'axiom.ask':
      return kernel.ask(args.question);
    case 'axiom.verify':
      return kernel.verify(args.statement);
    case 'axiom.plan':
      return agent.plan(args.goal, { maxSteps: args.maxSteps });
    case 'axiom.agent':
      return agent.run(args.goal, { maxSteps: args.maxSteps });
    case 'axiom.policy':
      return agent.inspectToolPolicy(args.tool, args.input || '', {
        goal: args.goal,
      });
    case 'axiom.approvals':
      return {
        pendingCount: _pendingApprovals.length + (agent.countPendingToolApprovals ? agent.countPendingToolApprovals() : 0),
        approvals: [
          ..._pendingApprovals,
          ...(agent.listPendingToolApprovals ? agent.listPendingToolApprovals(args.limit || 20) : []).map(item => ({
            id: item.id,
            approvalKey: item.approval_key || item.approvalKey || '',
            tool: item.tool,
            input: item.input || '',
            status: item.status || 'pending',
            decision: item.decision || '',
            reason: item.reason || '',
            createdAt: Number(item.created_at || 0),
            updatedAt: Number(item.updated_at || 0),
            policy: item.policy || {},
            context: item.context || {},
          })),
        ].slice(0, args.limit || 50),
      };
    case 'axiom.reason':
      return kernel.reason(args.subject);
    case 'axiom.compare':
      return kernel.compare(args.left, args.right);
    case 'axiom.dream':
      return kernel.dream({ depth: args.depth });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function executeReadOnlyDryRun(kernel, name, args) {
  const agent = createAgent({
    kernel,
    version: process.env.AXIOM_AGENT_VERSION,
  });
  switch (name) {
    case 'axiom.learn':
      return kernel.ask(`What would be learned from: ${(args.text || '').slice(0, 200)}`);
    case 'axiom.agent':
      return agent.plan ? agent.plan(args.goal || '', { maxSteps: args.maxSteps || 1 }) : { dryRun: true, goal: args.goal };
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
