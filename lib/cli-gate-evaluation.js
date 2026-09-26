const { normalizeCommandText } = require('./command-parser');
const { mapCliCommandToMcpTool } = require('./cli-helpers');
const { evaluateMcpGate } = require('./mcp-gate-adapter');

// #2136: the gate arguments each mapped MCP tool is evaluated with.
const CLI_GATE_ARGS = Object.freeze(Object.assign(Object.create(null), {
  'huqan.learn': (args) => ({ text: typeof args === 'string' ? args : JSON.stringify(args || {}) }),
  'huqan.agent': (args) => ({ goal: typeof args === 'string' ? args : JSON.stringify(args || {}) }),
  'huqan.ask': (args) => ({ question: String(args || '') }),
  'huqan.verify': (args) => ({ statement: String(args || '') }),
  'huqan.reason': (args) => ({ subject: String(args || '') }),
  'huqan.compare': (args) => {
    const [left = '', right = ''] = String(args || '').split('|');
    return { left: left.trim(), right: right.trim() };
  },
}));

// CLI#evaluateCliGate (cli.js). `evaluateMutationGate` is the CLI's own
// mutation gate, for commands with no MCP tool mapping.
function evaluateCliGate(evaluateMutationGate, command, args) {
  // Approval execution is delegated to the MCP approval handler. It validates
  // the persisted id and runs the admission-aware learn path, so a synthetic
  // CLI allow decision must not bypass that authority.
  if (normalizeCommandText(command) === 'onayla') return null;
  // The bare report is read-only; --propose and `review` both write to the
  // candidate-claim family and stay behind the gate.
  if (normalizeCommandText(command) === 'hypotheses'
    && !(args && typeof args === 'object'
      && (args.propose === true || args.review === true || (args.tuning === true && args.apply === true)))) return null;
  const tool = mapCliCommandToMcpTool(command);
  if (!tool) {
    // F-004: commands without an MCP tool mapping may still mutate. Route
    // them through the CLI mutation gate so they are never silently
    // bypassed. Genuinely read-only commands (durum, sor, selam, yardım…)
    // are absent from CLI_MUTATION_GATE and return null (no gate runs).
    return evaluateMutationGate(command, args);
  }

  const metadata = {
    source: 'cli',
    actor: 'cli-user',
    runner: 'cli',
    sourceTrust: 'local',
  };

  const gateArgs = Object.hasOwn(CLI_GATE_ARGS, tool) ? CLI_GATE_ARGS[tool](args) : {};

  return evaluateMcpGate({ tool, args: gateArgs, metadata });
}

module.exports = { evaluateCliGate, CLI_GATE_ARGS };
