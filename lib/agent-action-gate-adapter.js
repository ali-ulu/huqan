'use strict';

/**
 * AB-EXT — external agent action gate.
 *
 * `lib/mcp-gate-adapter.js` gates HUQAN's own MCP tools: a closed namespace
 * this repository owns end to end. This module gates the opposite direction —
 * a third-party coding agent's own tools (shell, file writes, network calls,
 * nested MCP calls), evaluated at that agent's pre-tool-call boundary, before
 * the action runs.
 *
 * Same gates, different entry surface. AB1 classifies the action, AB8 reads
 * shell commands, AB9 looks for secret/PII egress. Nothing here re-derives a
 * decision a gate already makes: this module maps one vocabulary onto the other
 * and merges what the gates return.
 *
 * Two deliberate differences from the MCP adapter, both following from the
 * agent's tool namespace being open where HUQAN's is closed:
 *
 * 1. An unrecognised tool returns `ask`, not `deny`. Users install arbitrary
 *    tools; denying every unfamiliar one makes the gate unusable, and an
 *    unusable gate gets switched off — strictly worse than one that escalates
 *    to a human. Malformed input and gate failures still deny, exactly as they
 *    do on the MCP side: those signal a broken call, not an unfamiliar one.
 * 2. `allow` means "this gate has no objection", never "skip the host's own
 *    permission prompt". The gate may only subtract permission. Granting it is
 *    the host's decision, and widening it here would silently overrule whatever
 *    the user configured.
 */

const {
  classifyAgentAction,
  ACTION_CATEGORIES,
  ACTION_DECISIONS,
  RISK_LEVELS,
} = require('./action-risk-classifier');
const { evaluateCommandExec, COMMAND_EXEC_DECISIONS } = require('./command-exec-gate');
const { evaluateEgress } = require('./data-egress-gate');

const AGENT_ACTION_GATE_VERSION = 'AB-EXT-v0.1.0';

const AGENT_GATE_DECISIONS = Object.freeze({
  allow: 'allow',
  ask: 'ask',
  deny: 'deny',
});

const AGENT_GATE_REASONS = Object.freeze({
  READ_ONLY_ALLOW: 'read_only_allow',
  NO_OBJECTION: 'no_gate_objection',
  UNKNOWN_TOOL_REVIEW: 'unknown_tool_review_required',
  MALFORMED_INPUT_DENIED: 'malformed_input_denied',
  AB1_CLASSIFIER: 'ab1_risk_classifier_decision',
  AB8_BLOCKED: 'ab8_command_exec_blocked',
  AB8_REVIEW: 'ab8_command_exec_review_required',
  AB9_EGRESS_REVIEW: 'ab9_data_egress_review_required',
  GATE_ERROR_DENIED: 'gate_evaluation_error_denied',
});

/**
 * Severity order. A later gate may raise the decision, never lower it, so the
 * merge is monotonic and gate ordering cannot change an outcome — the same
 * property `mergeMcpDecisions` gives the MCP chain.
 */
const DECISION_RANK = Object.freeze({ allow: 0, ask: 1, deny: 2 });

function mergeAgentDecisions(current, next) {
  if (!DECISION_RANK[next] && DECISION_RANK[next] !== 0) return current;
  return DECISION_RANK[next] > DECISION_RANK[current] ? next : current;
}

/**
 * Raise the running decision and record why. The reason belongs to the gate
 * that first reached the current severity: a later gate reaching the same level
 * has not changed the outcome, so it must not overwrite the attribution.
 */
function raiseDecision(state, next, reason) {
  const merged = mergeAgentDecisions(state.decision, next);
  if (DECISION_RANK[merged] > DECISION_RANK[state.decision]) {
    state.decision = merged;
    state.reason = reason;
    return true;
  }
  return false;
}

/** What a tool does, which decides which gates have anything to say about it. */
const TOOL_KINDS = Object.freeze({
  READ: 'read',
  SHELL: 'shell',
  FILE_WRITE: 'file_write',
  NETWORK: 'network',
});

/**
 * Keyed on the tool names a coding-agent host exposes. Anything absent — an
 * `mcp__*` tool from an installed server, a host-specific tool this table has
 * not seen — is unknown and escalates rather than resolving silently.
 */
const AGENT_TOOL_KINDS = Object.freeze({
  Read: TOOL_KINDS.READ,
  Glob: TOOL_KINDS.READ,
  Grep: TOOL_KINDS.READ,
  NotebookRead: TOOL_KINDS.READ,
  Bash: TOOL_KINDS.SHELL,
  Edit: TOOL_KINDS.FILE_WRITE,
  Write: TOOL_KINDS.FILE_WRITE,
  MultiEdit: TOOL_KINDS.FILE_WRITE,
  NotebookEdit: TOOL_KINDS.FILE_WRITE,
  WebFetch: TOOL_KINDS.NETWORK,
  WebSearch: TOOL_KINDS.NETWORK,
});

const TEST_PATH_PATTERN = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z0-9]+$/i;
const CODE_PATH_PATTERN = /\.(js|cjs|mjs|ts|tsx|jsx|rs|py|go|rb|java|sh|bash|sql|yml|yaml|json)$/i;

/**
 * AB1 already treats a security-sensitive path as critical regardless of which
 * write category it arrives under, so this only has to separate test edits from
 * ordinary source edits from everything else.
 */
function categoryForWritePath(filePath) {
  if (!filePath) return ACTION_CATEGORIES.FILESYSTEM_WRITE;
  if (TEST_PATH_PATTERN.test(filePath)) return ACTION_CATEGORIES.TEST_CHANGE;
  if (CODE_PATH_PATTERN.test(filePath)) return ACTION_CATEGORIES.CODE_CHANGE;
  return ACTION_CATEGORIES.FILESYSTEM_WRITE;
}

const AB1_TO_AGENT_DECISION = Object.freeze({
  [ACTION_DECISIONS.ALLOW]: AGENT_GATE_DECISIONS.allow,
  [ACTION_DECISIONS.QUARANTINE]: AGENT_GATE_DECISIONS.ask,
  [ACTION_DECISIONS.HUMAN_REVIEW]: AGENT_GATE_DECISIONS.ask,
  [ACTION_DECISIONS.BLOCK]: AGENT_GATE_DECISIONS.deny,
});

/**
 * AB1 answers `HUMAN_REVIEW` for every `CODE_CHANGE`, which is right for
 * HUQAN's own agent and wrong here: editing source is the whole job of the
 * agent this gate sits in front of, so forwarding that verbatim would prompt on
 * every edit until the user switched the gate off.
 *
 * What separates a routine edit from a dangerous one is already in AB1's own
 * output. A plain source edit classifies with an empty `flags` array; a
 * security-sensitive path, a write outside the allowlist or a production target
 * all raise a flag, and the hard-blocked cases come back as `BLOCK`. So a write
 * escalates on evidence AB1 actually produced, not on its base category.
 *
 * `TEST_CHANGE` is the one category that escalates without a flag:
 * `docs/agent-brake-layer.md` §5 protects tests from silent weakening, and the
 * security-sensitive path list cannot recognise which test guards a policy.
 *
 * Remember what `allow` means here (see the module header): the host's own
 * permission prompt still runs. This narrows what the gate adds on top of it,
 * it does not grant anything.
 */
function agentDecisionForWrite(ab1) {
  const mapped = AB1_TO_AGENT_DECISION[ab1.decision] || AGENT_GATE_DECISIONS.ask;
  if (mapped === AGENT_GATE_DECISIONS.deny) return mapped;
  const flags = Array.isArray(ab1.flags) ? ab1.flags : [];
  if (flags.length > 0) return mapped;
  if (ab1.category === ACTION_CATEGORIES.TEST_CHANGE) return AGENT_GATE_DECISIONS.ask;
  return AGENT_GATE_DECISIONS.allow;
}

function normalizeAgentActionInput(input) {
  if (!input || typeof input !== 'object') {
    return { malformed: true, tool: null, toolInput: {}, context: {} };
  }
  const tool = typeof input.toolName === 'string' ? input.toolName.trim() : '';
  const toolInput = input.toolInput && typeof input.toolInput === 'object' ? input.toolInput : {};
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  return { malformed: tool.length === 0, tool, toolInput, context };
}

function buildAgentDecision(decision, reason, overrides = {}) {
  return {
    ok: true,
    decision,
    allowed: decision === AGENT_GATE_DECISIONS.allow,
    canExecute: decision === AGENT_GATE_DECISIONS.allow,
    requiresReview: decision === AGENT_GATE_DECISIONS.ask,
    reason,
    risk: { level: RISK_LEVELS.LOW },
    findings: [],
    warnings: [],
    metadata: { adapterVersion: AGENT_ACTION_GATE_VERSION },
    ...overrides,
  };
}

/**
 * A gate that threw told us nothing, and "nothing" is not evidence of safety.
 * Mirrors `recordGateFailure` in the MCP adapter: record it and fail closed.
 */
function recordAgentGateFailure(gateName, tool, err, findings, warnings) {
  const message = err && typeof err.message === 'string' ? err.message : String(err);
  warnings.push(`${gateName} error: ${message}`);
  findings.push({
    gate: gateName,
    tool,
    error: message,
    decision: AGENT_GATE_DECISIONS.deny,
    failClosed: true,
  });
  return AGENT_GATE_DECISIONS.deny;
}

/** The path a write tool targets, whichever field name the host used for it. */
function writeTargetPath(toolInput) {
  const candidate = toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? toolInput.notebook_path;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function networkTargetUrl(toolInput) {
  const candidate = toolInput.url ?? toolInput.uri;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/**
 * Decide whether one proposed agent tool call may run.
 *
 * @param {{toolName: string, toolInput?: object, context?: object}} input
 * @param {{allowlistedPaths?: string[], allowlistedUrls?: string[]}} [options]
 *   forwarded verbatim to AB1, which owns what "allowlisted" means.
 */
function evaluateAgentAction(input, options = {}) {
  const normalized = normalizeAgentActionInput(input);
  if (normalized.malformed) {
    return buildAgentDecision(AGENT_GATE_DECISIONS.deny, AGENT_GATE_REASONS.MALFORMED_INPUT_DENIED, {
      risk: { level: RISK_LEVELS.CRITICAL },
      warnings: ['Malformed agent action input'],
    });
  }

  const { tool, toolInput, context } = normalized;
  const kind = AGENT_TOOL_KINDS[tool] || null;
  if (!kind) {
    return buildAgentDecision(AGENT_GATE_DECISIONS.ask, AGENT_GATE_REASONS.UNKNOWN_TOOL_REVIEW, {
      risk: { level: RISK_LEVELS.MEDIUM },
      metadata: { adapterVersion: AGENT_ACTION_GATE_VERSION, tool, known: false },
    });
  }

  if (kind === TOOL_KINDS.READ) {
    return buildAgentDecision(AGENT_GATE_DECISIONS.allow, AGENT_GATE_REASONS.READ_ONLY_ALLOW, {
      metadata: { adapterVersion: AGENT_ACTION_GATE_VERSION, tool, known: true },
    });
  }

  const findings = [];
  const warnings = [];
  const state = {
    decision: AGENT_GATE_DECISIONS.allow,
    reason: AGENT_GATE_REASONS.NO_OBJECTION,
    riskLevel: RISK_LEVELS.LOW,
  };

  if (kind === TOOL_KINDS.SHELL) {
    try {
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      const ab8 = evaluateCommandExec({
        command,
        workspaceRoot: context.workspaceRoot || context.cwd || null,
        cwd: context.cwd || null,
      });
      findings.push({
        gate: 'AB8',
        tool,
        decision: ab8.decision,
        reason: ab8.reason,
        denylistMatch: ab8.denylistMatch,
        outOfWorkspaceTarget: ab8.outOfWorkspaceTarget,
      });
      if (ab8.decision === COMMAND_EXEC_DECISIONS.BLOCK) {
        if (raiseDecision(state, AGENT_GATE_DECISIONS.deny, AGENT_GATE_REASONS.AB8_BLOCKED)) {
          state.riskLevel = RISK_LEVELS.CRITICAL;
        }
      } else if (ab8.decision === COMMAND_EXEC_DECISIONS.REVIEW) {
        if (raiseDecision(state, AGENT_GATE_DECISIONS.ask, AGENT_GATE_REASONS.AB8_REVIEW)) {
          state.riskLevel = RISK_LEVELS.HIGH;
        }
      }
    } catch (err) {
      const failed = recordAgentGateFailure('AB8', tool, err, findings, warnings);
      if (raiseDecision(state, failed, AGENT_GATE_REASONS.GATE_ERROR_DENIED)) {
        state.riskLevel = RISK_LEVELS.CRITICAL;
      }
    }
  }

  if (kind === TOOL_KINDS.FILE_WRITE || kind === TOOL_KINDS.NETWORK) {
    try {
      const isWrite = kind === TOOL_KINDS.FILE_WRITE;
      const path = isWrite ? writeTargetPath(toolInput) : null;
      const url = isWrite ? null : networkTargetUrl(toolInput);
      const ab1 = classifyAgentAction({
        category: isWrite ? categoryForWritePath(path) : ACTION_CATEGORIES.NETWORK_CALL,
        action: tool,
        target: isWrite ? { path } : { url },
      }, options);
      findings.push({
        gate: 'AB1',
        tool,
        category: ab1.category,
        decision: ab1.decision,
        riskLevel: ab1.riskLevel,
        flags: ab1.flags,
      });
      const mapped = isWrite
        ? agentDecisionForWrite(ab1)
        : (AB1_TO_AGENT_DECISION[ab1.decision] || AGENT_GATE_DECISIONS.ask);
      if (raiseDecision(state, mapped, AGENT_GATE_REASONS.AB1_CLASSIFIER)) {
        state.riskLevel = ab1.riskLevel || state.riskLevel;
      }
    } catch (err) {
      const failed = recordAgentGateFailure('AB1', tool, err, findings, warnings);
      if (raiseDecision(state, failed, AGENT_GATE_REASONS.GATE_ERROR_DENIED)) {
        state.riskLevel = RISK_LEVELS.CRITICAL;
      }
    }
  }

  // AB9 reads what the action would carry outward. A denied action does not
  // need the extra scan, but an allowed or reviewed one does: this is the only
  // gate that looks at the payload rather than at the operation.
  if (state.decision !== AGENT_GATE_DECISIONS.deny) {
    try {
      const egress = evaluateEgress(toolInput);
      findings.push({
        gate: 'AB9',
        tool,
        piiDetected: egress.piiDetected,
        piiTypes: egress.piiTypes,
        secretDetected: egress.secretDetected,
      });
      if (egress.piiDetected || egress.secretDetected) {
        raiseDecision(state, AGENT_GATE_DECISIONS.ask, AGENT_GATE_REASONS.AB9_EGRESS_REVIEW);
      }
    } catch (err) {
      const failed = recordAgentGateFailure('AB9', tool, err, findings, warnings);
      if (raiseDecision(state, failed, AGENT_GATE_REASONS.GATE_ERROR_DENIED)) {
        state.riskLevel = RISK_LEVELS.CRITICAL;
      }
    }
  }

  return buildAgentDecision(state.decision, state.reason, {
    risk: { level: state.riskLevel },
    findings,
    warnings,
    metadata: { adapterVersion: AGENT_ACTION_GATE_VERSION, tool, kind, known: true },
  });
}

module.exports = {
  AGENT_ACTION_GATE_VERSION,
  AGENT_GATE_DECISIONS,
  AGENT_GATE_REASONS,
  AGENT_TOOL_KINDS,
  TOOL_KINDS,
  categoryForWritePath,
  mergeAgentDecisions,
  normalizeAgentActionInput,
  evaluateAgentAction,
};
