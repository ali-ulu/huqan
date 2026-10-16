const { normalizeCommandText } = require('./command-parser');
const { mapCliCommandToMcpTool } = require('./cli-helpers');
const { evaluateMcpGate } = require('./mcp-gate-adapter');
const { emergencyStopLedger } = require('./emergency-stop');

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
// mutation gate, for commands with no MCP tool mapping. `kernel` is optional:
// when the caller has it, the gate consults the signal provider.
function evaluateCliGate(evaluateMutationGate, command, args, kernel = null) {
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

  // The CLI holds the kernel, so its gate consults the signal provider: a
  // plugin's beforeGateDecision signal and any active error-prevention rule can
  // escalate the decision here, exactly as they do on the MCP path.
  return evaluateMcpGate({ tool, args: gateArgs, metadata }, { kernel });
}

// The CLI half of the emergency-stop parity (#3905).
//
// MCP refuses every non-operator tool under a workspace stop and HTTP answers
// 423 EMERGENCY_STOPPED on the read/query surfaces, but `huqan sor` /
// `huqan verify` kept answering from the same stopped workspace: CLI#execute
// never consulted the ledger. This is the one place the CLI reads it, so the
// surfaces cannot drift from each other or from the MCP check. The ledger is
// resolved the same way everywhere else resolves it: an injected ledger when a
// caller supplies one (tests), otherwise one over HUQAN_EMERGENCY_STOP_DIR or
// the state root -- the same directory `huqan stop` writes to. Never from
// command input.
//
// Fail-closed allowlist: under a stop only the commands that never touch the
// stopped workspace stay reachable -- the approval review path (the MCP
// operator-tool mirror, so a stop can still be reviewed), diagnostics,
// static text, and quickstart (throwaway demo store, #3649). Stop management
// itself (stop/lift/integrity) never reaches execute(); it is handled before
// the interactive parser. Everything else refuses with the same
// EMERGENCY_STOPPED code MCP and HTTP answer, so one grep finds every
// surface.

const EMERGENCY_STOPPED_CODE = 'EMERGENCY_STOPPED';

// The CLI is a single-workspace caller: its kernel answers from the default
// workspace, so that is the scope a stop is checked against -- the same scope
// `huqan stop --scope workspace --workspace default` writes.
const CLI_STOP_WORKSPACE_ID = 'default';

const COMMANDS_REACHABLE_UNDER_STOP = Object.freeze(new Set([
  // Approval review path: the MCP operator-tool mirror.
  'onaylar',
  'onayla',
  // Diagnostics must keep working under a stop; doctor reports the stop.
  'doctor',
  'durum',
  // Static text: no store read.
  'yardım',
  'selam',
  'anlamadım',
  // Throwaway demo store; never touches the caller's workspace (#3649).
  'quickstart',
]));

/**
 * The refusal for a stopped workspace, or null when the command may proceed.
 *
 * @param {{ emergencyStop?: object, command?: string }} options
 * @returns {null | { code: string, scope: string|null, reason: string|null }}
 */
function cliEmergencyStopRefusal({ emergencyStop, command } = {}) {
  if (COMMANDS_REACHABLE_UNDER_STOP.has(String(command || ''))) return null;
  const stop = emergencyStopLedger({ emergencyStop }).check({ workspaceId: CLI_STOP_WORKSPACE_ID });
  if (!stop || stop.stopped !== true) return null;
  return Object.freeze({
    code: EMERGENCY_STOPPED_CODE,
    scope: stop.scope || null,
    reason: stop.reason || null,
  });
}

/**
 * The refusal shaped for the caller: a JSON envelope under --json (so the
 * argv dispatcher maps it to the blocked exit code), plain operator text
 * otherwise (REPL and human argv).
 */
function formatCliEmergencyStopRefusal(refusal, { json } = {}) {
  const message = `DURDURULDU [${refusal.code}]: default workspace acil durdurma altinda`
    + ` (scope: ${refusal.scope || 'workspace'}). Once kaldir: huqan lift --scope workspace --workspace default.`;
  if (json === true) {
    return {
      ok: false,
      status: 'blocked',
      data: null,
      error: { code: refusal.code, message },
    };
  }
  return message;
}

module.exports = { evaluateCliGate, CLI_GATE_ARGS, EMERGENCY_STOPPED_CODE, CLI_STOP_WORKSPACE_ID, COMMANDS_REACHABLE_UNDER_STOP, cliEmergencyStopRefusal, formatCliEmergencyStopRefusal };
