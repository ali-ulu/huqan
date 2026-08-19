'use strict';

/**
 * The policy answer for a HUQAN MCP tool, in the shape toolPolicy.js returns.
 *
 * `huqan.policy` is the surface an evaluator inspects first: it is how you ask
 * the product what it will do before asking it to do anything. It answered
 * from toolPolicy.js alone, whose INTERNAL_TOOLS is the *agent loop's* tool
 * set, so it contradicted lib/mcp-gate-adapter.js -- the actual authority for
 * what an MCP call does -- on every MCP tool that is not an agent step:
 *
 *   huqan.policy {tool: "huqan.plan"}
 *     -> external / block / unknown-tool-blocked, riskScore 70
 *   the gate that actually runs huqan.plan
 *     -> allow (read_only_allow)
 *
 * They were answering different questions with the same vocabulary. This
 * module makes the MCP question answerable from the MCP authority: when the
 * requested name is a HUQAN MCP tool, the answer comes from
 * classifyMcpTool(); anything else falls through to toolPolicy.js unchanged.
 *
 * Note this deliberately makes `huqan.learn` and bare `learn` differ:
 *
 *   learn        -> allow   (the agent loop may choose it as a step)
 *   huqan.learn  -> review  (an MCP call to it is gated by AB4)
 *
 * That is not the inconsistency the namespace fix removed. That one was a
 * single question with two answers, where one of them called HUQAN's own
 * advertised tool an unknown third-party tool. This is two different
 * questions, each answered by the authority that owns it, and `huqan.learn`
 * now agrees with what calling huqan.learn actually does.
 */

const { classifyMcpTool, MCP_GATE_REASONS } = require('./mcp-gate-adapter');
const { localMcpToolName } = require('./mcp-tool-names');

// The alphaDecision vocabulary, projected onto the fields toolPolicy.js
// callers already read. `category` stays inside the existing
// internal/external split rather than gaining a third value: a consumer
// branching on it must not have to learn a new word to keep working.
const DECISION_VIEWS = Object.freeze({
  allow: Object.freeze({
    action: 'allow',
    approval: 'auto',
    blocked: false,
    requiresApproval: false,
    review: false,
    riskScore: 0,
    labels: ['huqan-mcp-tool', 'read-only'],
    reason: MCP_GATE_REASONS.READ_ONLY_ALLOW,
    detail: 'Read-only HUQAN MCP tool.',
    nextStep: 'No additional action required.',
    executionMode: 'direct',
  }),
  review: Object.freeze({
    action: 'review',
    approval: 'review',
    blocked: false,
    requiresApproval: true,
    review: true,
    riskScore: 35,
    labels: ['huqan-mcp-tool', 'mutating', 'requires-approval'],
    reason: MCP_GATE_REASONS.MUTATING_REVIEW,
    detail: 'Mutating HUQAN MCP tool; a canonical write needs an approval.',
    nextStep: 'Call the operator-only huqan.approve to resolve the approval.',
    executionMode: 'direct',
  }),
  dry_run_only: Object.freeze({
    action: 'dry_run_only',
    approval: 'dry-run',
    blocked: false,
    requiresApproval: false,
    review: false,
    riskScore: 20,
    labels: ['huqan-mcp-tool', 'agent-loop', 'dry-run-only'],
    reason: MCP_GATE_REASONS.AGENT_LOOP_DRY_RUN,
    detail: 'HUQAN agent loop; runs dry-run only over MCP.',
    nextStep: 'Inspect the dry-run plan; it performs no canonical write.',
    executionMode: 'dry-run',
  }),
});

/**
 * @param {string} tool a normalized tool name
 * @returns {object|null} a toolPolicy-shaped result, or null when `tool` is
 *   not a HUQAN MCP tool and the agent-loop policy should answer instead.
 */
function mcpToolPolicy(tool) {
  // Operator-only tools are excluded on purpose. They are withheld from
  // tools/list and gated by HUQAN_MCP_OPERATOR_TOKEN rather than by the gate
  // adapter, so classifyMcpTool reports them unknown -- and an unknown tool
  // must keep reaching the fail-closed branch, not gain an answer here.
  if (localMcpToolName(tool) === null) return null;

  const classification = classifyMcpTool(tool);
  if (!classification || classification.known !== true) return null;

  const view = DECISION_VIEWS[classification.alphaDecision];
  if (!view) return null;

  return {
    tool,
    category: 'internal',
    action: view.action,
    approval: view.approval,
    blocked: view.blocked,
    requiresApproval: view.requiresApproval,
    review: view.review,
    riskScore: view.riskScore,
    confidence: 1,
    labels: [...view.labels],
    reasons: [view.detail, `Gate decision: ${view.reason}.`],
    suggestedNextStep: view.nextStep,
    source: 'mcpToolPolicy',
    executionMode: view.executionMode,
    sandbox: null,
    mcp: {
      known: true,
      mutating: classification.mutating,
      surfaceCategory: classification.category,
      gateDecision: classification.alphaDecision,
      gates: [...classification.gates],
    },
  };
}

module.exports = { mcpToolPolicy, DECISION_VIEWS };
