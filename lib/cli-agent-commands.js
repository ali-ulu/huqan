const { isWorkflowRuntime, unwrapAgentPayload, formatAgentRunResult } = require('./cli-helpers');
const { runCliHypotheses } = require('./cli-hypotheses');
const { runQuickstartCommand } = require('./quickstart-cli');
const { CLI_MUTATION_GATE } = require('./cli-mutation-gate');

// CLI command handlers (cli.js registry): agent plan/run, hypotheses, quickstart.

function planCommand(cli, args, opts, command) {
  const result = cli.agent.plan(args);
  const plan = unwrapAgentPayload(result);
  if (opts.json) return result;
  const steps = (plan.steps || []).map((step, index) => `  ${index + 1}. ${step.action} -> ${step.tool} | ${step.rationale}`).join('\n');
  const nextAction = plan.nextAction ? `${plan.nextAction.action} -> ${plan.nextAction.tool}` : 'none';
  const recommendations = Array.isArray(plan.recommendations?.items) ? plan.recommendations.items : [];
  const runtimeLine = isWorkflowRuntime(cli.agent) ? 'Runtime: workflow' : 'Runtime: legacy';
  return [
    `Ajan planı: ${plan.objective} (${plan.status})`,
    `Hedef: ${plan.goal}`,
    runtimeLine,
    `Seçilen araçlar: ${(plan.selectedTools || []).join(', ') || 'yok'}`,
    `Next step: ${nextAction}`,
    `Recommendations: ${recommendations.length > 0 ? recommendations.join(' | ') : 'none'}`,
  `Steps:\n${steps || '  -'}`,
    `Güven: ${plan.confidence.toFixed(2)}`,
  ].join('\n');
}

function agentRunCommand(cli, args, opts, command) {
  const result = cli.agent.run(args);
  if (opts.json) return result;
  return result && typeof result.then === 'function'
    ? result.then(resolved => formatAgentRunResult(cli.agent, resolved))
    : formatAgentRunResult(cli.agent, result);
}

function hypothesesCommand(cli, args, opts, command) {
  const argsObject = args && typeof args === 'object' ? args : {};
  const applies = argsObject.tuning === true && argsObject.apply === true;
  const writes = argsObject.propose === true || argsObject.review === true;
  return runCliHypotheses(cli.kernel, argsObject, {
    json: opts.json === true,
    commitMutation: applies
      ? () => cli.commitCliMutation('hypotheses-tuning-apply', CLI_MUTATION_GATE['hypotheses-tuning-apply'])
      : writes
        ? () => cli.commitCliMutation('hypotheses', CLI_MUTATION_GATE.hypotheses)
        : null,
  });
}

// The MCP collaborators are handed in by cli.js: lib/ sits inside the UI ring.
function createQuickstartCommand({ callMcpTool, createApprovalStoreFromKernel }) {
  return function quickstartCommand(cli, args, opts, command) {
    return runQuickstartCommand({
      callTool: callMcpTool,
      createApprovalStore: createApprovalStoreFromKernel,
      operatorToken: cli.mcpOperatorToken,
      createOperatorCapability: ({ tool, arguments: args }) => cli.createOperatorCapability(tool, args),
    });
  };
}

module.exports = {
  planCommand,
  agentRunCommand,
  hypothesesCommand,
  createQuickstartCommand,
};
