'use strict';

// #2169: turning one MCP tool call into the input each gate expects
// (AB1 action risk, AB2 tool call, AB4 memory, AB5 automation, AB8 command,
// AB11 cross-workspace).

const { ACTION_CATEGORIES } = require('./action-risk-classifier');
const { canonicalMcpToolName } = require('./mcp-tool-names');
const { isPlainObject } = require('./is-plain-object');
const { MCP_TOOL_CLASSIFICATIONS } = require('./mcp-gate-adapter-contract');

function normalizeMcpToolInput(input) {
  if (!input || typeof input !== 'object') {
    return { raw: input, tool: null, args: null, metadata: null, malformed: true };
  }
  const tool = typeof input.tool === 'string' ? input.tool.trim() : null;
  const args = input.args && typeof input.args === 'object' ? input.args : {};
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  return { raw: input, tool, args, metadata, malformed: !tool };
}

function classifyMcpTool(tool) {
  const name = canonicalMcpToolName(tool);
  if (!Object.hasOwn(MCP_TOOL_CLASSIFICATIONS, name)) {
    // Unknown tools are blocked before any gate runs, so this list is
    // informational; left unchanged rather than grown for appearance.
    return { known: false, mutating: true, category: 'unknown', alphaDecision: 'block', gates: ['AB1', 'AB2'] };
  }
  const classification = MCP_TOOL_CLASSIFICATIONS[name];
  return { known: true, ...classification };
}

function buildAb1Input(tool, args, metadata) {
  const classification = classifyMcpTool(tool);
  let category;
  if (classification.category === 'read') {
    category = ACTION_CATEGORIES.READ_ONLY;
  } else if (classification.category === 'write') {
    category = ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE;
  } else if (classification.category === 'agent-loop') {
    category = ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
  } else {
    category = ACTION_CATEGORIES.READ_ONLY;
  }
  return {
    action: `mcp.${tool}`,
    category,
    target: tool,
    context: {
      source: 'mcp',
      args: JSON.stringify(args || {}).slice(0, 500),
      ...(metadata || {}),
    },
  };
}

function buildAb2Input(tool, args, ab1Result) {
  return {
    tool: `mcp.${tool}`,
    input: JSON.stringify(args || {}).slice(0, 500),
    action: ab1Result || undefined,
    dryRun: false,
  };
}

function deriveMcpAction(tool, args) {
  if (isPlainObject(args)) {
    for (const key of ['action', 'operation', 'mode', 'intent', 'kind', 'type']) {
      if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim();
    }
  }
  return typeof tool === 'string' ? tool.split('.').pop() : '';
}

function buildAb4Input(tool, args) {
  const action = deriveMcpAction(tool, args);
  const workspaceId = isPlainObject(args) && typeof args.workspaceId === 'string' && args.workspaceId.trim()
    ? args.workspaceId.trim()
    : 'default';
  return {
    entries: [{
      id: `mcp-${tool}-${Date.now()}`,
      action,
      changeType: 'content',
      scope: workspaceId,
      workspaceId,
      content: args?.text || '',
    }],
    operationType: action,
    mutationType: 'graph',
    targetSpace: workspaceId,
  };
}

function buildAb5Input(tool, args, metadata) {
  const explicitAction = deriveMcpAction(tool, args);
  const goal = typeof args?.goal === 'string' ? args.goal.trim() : '';
  const action = explicitAction && explicitAction !== tool.split('.').pop() ? explicitAction : (goal || explicitAction);
  const operation = {
    action,
    operationType: action,
    target: args?.target || args?.resource || tool,
  };
  for (const key of ['command', 'cmd', 'shell', 'script', 'exec', 'branch', 'baseBranch', 'deploy', 'release', 'merge']) {
    if (args && args[key] !== undefined) operation[key] = args[key];
  }
  return {
    operation,
    operationType: action || 'unknown',
    target: operation.target,
    actor: metadata?.actor || 'mcp-client',
    branch: metadata?.branch || args?.branch || '',
    baseBranch: metadata?.baseBranch || args?.baseBranch || '',
    preview: Boolean(args?.preview || args?.dryRun),
    dryRun: Boolean(args?.dryRun),
    metadata: { source: 'mcp', tool },
  };
}

/**
 * AB8 only has one real command-bearing surface today: huqan.agent's free-text
 * `goal`, which an agent loop could plausibly turn into a literal shell
 * command. This pulls out the same command-shaped fields command-exec-gate
 * itself recognizes (command/cmd/shell/script/exec), falling back to `goal`
 * since that is the field huqan.agent actually declares.
 */
function buildAb8CommandText(tool, args) {
  if (!isPlainObject(args)) return '';
  return String(args.command ?? args.cmd ?? args.shell ?? args.script ?? args.exec ?? args.goal ?? '');
}

/**
 * AB11 only has something to decide when a call actually expresses a
 * cross-workspace intent: metadata names the workspace the caller operates
 * in, and args name a different workspace to act on.
 *
 * When a call declares no workspace at all it is not making a cross-workspace
 * claim, and this adapter deliberately does not invent one. Requiring every
 * MCP caller to declare a workspace would be a breaking interface change and
 * belongs to its own decision, not to a gate wiring.
 */
function buildAb11Input(args, metadata) {
  const actorWorkspaceId = isPlainObject(metadata) ? metadata.workspaceId : undefined;
  const targetWorkspaceId = isPlainObject(args) ? args.workspaceId : undefined;
  const declared = typeof actorWorkspaceId === 'string' && actorWorkspaceId.trim()
    && typeof targetWorkspaceId === 'string' && targetWorkspaceId.trim();

  if (!declared) return null;

  return {
    actorWorkspaceId,
    targetWorkspaceId,
    operation: deriveMcpAction('', args),
    grants: isPlainObject(metadata) && Array.isArray(metadata.workspaceGrants) ? metadata.workspaceGrants : [],
    resourceType: 'mcp-tool',
  };
}

module.exports = {
  buildAb11Input,
  buildAb1Input,
  buildAb2Input,
  buildAb4Input,
  buildAb5Input,
  buildAb8CommandText,
  classifyMcpTool,
  deriveMcpAction,
  normalizeMcpToolInput,
};
