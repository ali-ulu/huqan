'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isPathWithinRoot } = require('./path-safety');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const { normalizeCommandText } = require('./command-parser');

function shellQuote(value) {
  const text = value == null ? '' : String(value);
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function getCliReadRoots() {
  const roots = [process.cwd(), os.tmpdir()];
  const extra = String(readCompatibleEnvironmentVariable('CLI_READ_ROOTS') || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => path.resolve(entry));
  const resolved = [...roots.map(entry => path.resolve(entry)), ...extra];
  // Accept each root's real path too, so a realpath'd candidate under a
  // symlinked root (macOS /var -> /private/var) is still inside it.
  const real = resolved.map((entry) => {
    try { return fs.realpathSync(entry); } catch (_) { return entry; }
  });
  return [...new Set([...resolved, ...real])];
}

function resolveCliReadPath(candidate) {
  const raw = String(candidate == null ? '' : candidate).trim();
  if (!raw) {
    const err = new Error('File path cannot be empty');
    err.code = 'CLI_PATH_NOT_ALLOWED';
    throw err;
  }
  const resolved = path.resolve(process.cwd(), raw);
  const roots = getCliReadRoots();
  const candidates = [resolved];
  try {
    candidates.push(fs.realpathSync(resolved));
  } catch (_) {
    // Missing file: readFileSync below reports it.
  }
  const allowed = candidates.every(item => roots.some(root => isPathWithinRoot(root, item)));
  if (!allowed) {
    const err = new Error(`File path is outside the allowed directories: ${raw}`);
    err.code = 'CLI_PATH_NOT_ALLOWED';
    throw err;
  }
  return resolved;
}

function isWorkflowRuntime(agent) {
  return Boolean(agent && (agent.kind === 'workflow' || agent.runtime === 'workflow'));
}

function unwrapAgentPayload(result) {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'data')) {
    return result.data;
  }
  return result;
}

function formatAgentRunResult(agent, result) {
  const data = unwrapAgentPayload(result);
  const agentStatus = typeof agent.getStatus === 'function' ? agent.getStatus() : null;
  const lastPlan = agentStatus?.lastPlan || null;
  const lastRun = agentStatus?.lastRun || null;
  const steps = (data.steps || []).map((step, index) => {
    const status = step.result?.ok === false ? 'error' : 'done';
    return `  ${index + 1}. ${step.action} -> ${status}${step.summary ? ` | ${step.summary}` : ''}`;
  }).join('\n');
  const nextAction = data.nextAction ? `${data.nextAction.action} -> ${data.nextAction.tool}` : 'none';
  const recommendations = Array.isArray(data.recommendations?.items) ? data.recommendations.items : [];
  const runtimeLine = isWorkflowRuntime(agent) ? 'Runtime: workflow' : 'Runtime: legacy';
  return [
    `Agent status: ${data.status}`,
    `Goal: ${data.goal}`,
    `Objective: ${data.objective}`,
    runtimeLine,
    data.checkpointId ? `Checkpoint: ${data.checkpointId}${data.resumed ? ' (resume)' : ''}` : 'Checkpoint: none',
    typeof data.budgetRemaining === 'number' ? `Budget remaining: ${data.budgetRemaining}` : 'Budget remaining: unknown',
    lastPlan ? `Last plan: ${lastPlan.goal} (${lastPlan.steps} steps)` : 'Last plan: none',
    lastRun ? `Last run: ${lastRun.status} · ${lastRun.goal}` : 'Last run: none',
    `Tools: ${(data.selectedTools || []).join(', ') || 'none'}`,
    `Next step: ${nextAction}`,
    `Recommendations: ${recommendations.length > 0 ? recommendations.join(' | ') : 'none'}`,
    `Steps:\n${steps || '  -'}`,
    `Result: ${data.finalAnswer}`,
  ].join('\n');
}

// #2346: Turkish CLI aliases for MCP tools. This is data, not control flow:
// a new alias extends the table below without touching the lookup. Keys are
// stored post-normalization (see normalizeCommandText); unknown commands
// fall through to null so the gate treats them as unmapped, never as a tool.
const CLI_COMMAND_TO_MCP_TOOL = new Map(Object.entries({
  ogret: 'huqan.learn',
  ogren: 'huqan.learn',
  yukle: 'huqan.learn',
  'company-ingest': 'huqan.learn',
  'company ingest': 'huqan.learn',
  ajan: 'huqan.agent',
  plan: 'huqan.agent',
  onaylar: 'huqan.approvals',
  sor: 'huqan.ask',
  verify: 'huqan.verify',
  neden: 'huqan.reason',
  karsilastir: 'huqan.compare',
}));

function mapCliCommandToMcpTool(command) {
  return CLI_COMMAND_TO_MCP_TOOL.get(normalizeCommandText(command)) ?? null;
}

// F-004: CLI mutation/maintenance commands that have no huqan.* MCP tool
// mapping but still affect persistence, canonical graph, or background
// automation. Every command in CLI_MUTATION_GATE is REST-blocked via
// requestGuards UNSAFE_PUBLIC_API_COMMANDS; the CLI must likewise never
// silently bypass the gate. The table and its decision semantics live in
// lib/cli-mutation-gate.js alongside the audit write they depend on.
function commandFailure(message, opts = {}, exitCode = 1) {
  if (opts.throwOnError === true) {
    const error = new Error(message);
    error.exitCode = exitCode;
    throw error;
  }
  return message;
}

function reportCommandStatus(opts, status) {
  if (typeof opts.onResult === 'function') opts.onResult({ status });
}

module.exports = {
  reportCommandStatus,
  shellQuote,
  getCliReadRoots,
  resolveCliReadPath,
  isWorkflowRuntime,
  unwrapAgentPayload,
  formatAgentRunResult,
  mapCliCommandToMcpTool,
  commandFailure,
};
