'use strict';

const { evaluateExternalAction } = require('./external-action-guard');

const EXTERNAL_ADAPTER_PROFILES = Object.freeze({
  GENERIC: 'generic',
  CLAUDE_CODE: 'claude-code',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  PI: 'pi',
  HERMES: 'hermes',
});

function normalizeProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  return Object.values(EXTERNAL_ADAPTER_PROFILES).includes(profile) ? profile : EXTERNAL_ADAPTER_PROFILES.GENERIC;
}

function normalizeHookInvocation(profileValue, payload = {}, options = {}) {
  const profile = normalizeProfile(profileValue);
  if (profile === EXTERNAL_ADAPTER_PROFILES.GENERIC) return { ...payload, agentName: payload.agentName || options.agentName || 'generic-agent' };
  if ([EXTERNAL_ADAPTER_PROFILES.CLAUDE_CODE, EXTERNAL_ADAPTER_PROFILES.CODEX].includes(profile)) {
    return {
      invocationId: payload.tool_use_id || payload.toolUseId,
      agentName: profile,
      agentVersion: options.agentVersion,
      sessionId: payload.session_id,
      turnId: payload.turn_id,
      toolName: payload.tool_name,
      args: payload.tool_input || {},
      cwd: payload.cwd,
      workspaceRoot: options.workspaceRoot || payload.cwd,
      workspaceId: options.workspaceId || 'default',
      // Host-reported, never attested: Codex's PreToolUse payload carries
      // agent_id, agent_type, model and permission_mode (its own input schema
      // requires all four). None of it can stand in for a capability card --
      // it is whatever the host said about itself -- but leaving it on the
      // floor costs the receipt the answers to "which agent, which model, and
      // was it running with permissions bypassed".
      metadata: {
        permissionMode: payload.permission_mode,
        hostAgentId: payload.agent_id,
        hostAgentType: payload.agent_type,
        hostModel: payload.model,
      },
    };
  }
  if (profile === EXTERNAL_ADAPTER_PROFILES.HERMES) {
    return {
      invocationId: payload.tool_call_id,
      agentName: profile,
      sessionId: payload.session_id || payload.task_id,
      turnId: payload.turn_id,
      toolName: payload.tool_name,
      args: payload.args || {},
      cwd: payload.cwd || options.cwd,
      workspaceRoot: options.workspaceRoot || payload.cwd || options.cwd,
      workspaceId: options.workspaceId || 'default',
    };
  }
  if (profile === EXTERNAL_ADAPTER_PROFILES.PI) {
    const event = payload.event || payload;
    return {
      invocationId: event.toolCallId,
      agentName: profile,
      sessionId: payload.sessionId || options.sessionId,
      turnId: payload.turnId,
      toolName: event.toolName,
      args: event.input || {},
      cwd: payload.cwd || options.cwd,
      workspaceRoot: options.workspaceRoot || payload.cwd || options.cwd,
      workspaceId: options.workspaceId || 'default',
    };
  }
  const input = payload.input || payload;
  const output = payload.output || {};
  return {
    invocationId: input.callID || input.toolCallId,
    agentName: profile,
    sessionId: input.sessionID || input.sessionId || options.sessionId,
    turnId: input.messageID || input.turnId,
    toolName: input.tool,
    args: output.args || input.args || {},
    cwd: input.cwd || options.cwd,
    workspaceRoot: options.workspaceRoot || input.cwd || options.cwd,
    workspaceId: options.workspaceId || 'default',
  };
}

function projectHookDecision(profileValue, result) {
  const profile = normalizeProfile(profileValue);
  const reason = result.decision === 'review'
    ? `HUQAN review required: ${result.reason}`
    : `HUQAN blocked action: ${result.reason}`;
  if (profile === EXTERNAL_ADAPTER_PROFILES.CLAUDE_CODE) {
    if (result.decision === 'allow') return { exitCode: 0, output: {} };
    return {
      exitCode: 0,
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: result.decision === 'review' ? 'ask' : 'deny',
          permissionDecisionReason: reason,
        },
      },
    };
  }
  if (profile === EXTERNAL_ADAPTER_PROFILES.CODEX) {
    if (result.decision === 'allow') return { exitCode: 0, output: {} };
    // Codex's wire schema lists allow/deny/ask, but this runtime rejects two
    // of the three -- "PreToolUse hook returned unsupported
    // permissionDecision:ask" is one of its own error strings, and an output
    // it rejects is an output it ignores, which would turn a review into a
    // silent allow. So a review is enforced as a deny, and the reason has to
    // carry the difference the decision field cannot: a review is a pending
    // human decision, not a denylist hit.
    return {
      exitCode: 0,
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.decision === 'review'
            ? `${reason} (human decision pending, not a denylist block; enforced as deny because Codex hooks implement deny only). Receipt ${result.receipt.receiptId}`
            : `${reason}. Receipt ${result.receipt.receiptId}`,
        },
      },
    };
  }
  if (profile === EXTERNAL_ADAPTER_PROFILES.HERMES) {
    return result.decision === 'allow'
      ? { exitCode: 0, output: {} }
      : { exitCode: 0, output: { action: 'block', message: reason } };
  }
  return {
    exitCode: result.decision === 'allow' ? 0 : result.decision === 'review' ? 3 : 2,
    output: {
      schemaVersion: 'huqan.guard-decision.v1',
      decision: result.decision,
      reason: result.reason,
      receiptId: result.receipt.receiptId,
      receiptHash: result.receipt.receiptHash,
      identityRef: result.envelope.identity?.identityRef || '',
      identityAttested: Boolean(result.envelope.identity?.attested),
      autonomyTier: result.envelope.autonomy?.tier || '',
      autonomyScore: Number.isFinite(result.envelope.autonomy?.score) ? result.envelope.autonomy.score : null,
    },
  };
}

function evaluateHookInvocation(profile, payload, options = {}) {
  const normalized = normalizeHookInvocation(profile, payload, options);
  // The capability card is deployment configuration, not something the hosting
  // agent gets to assert about itself in its own payload — it is attached from
  // options and overrides whatever the payload carried.
  const invocation = options.identityCard
    ? { ...normalized, identity: options.identityCard, identityCardSignature: options.identityCardSignature }
    : normalized;
  const result = evaluateExternalAction(invocation, options);
  return { invocation, result, projection: projectHookDecision(profile, result) };
}

/**
 * In-process guards default to writing receipts, because the CLI hook path
 * does (bin/huqan-gate-hook.js) and a deployment should not silently lose its
 * evidence trail by choosing a different client. Without this an opencode or
 * pi install blocks correctly and leaves nothing to look at afterwards (#1792).
 *
 * JSONL rather than the durable writer on purpose: the durable one also opens
 * the graph, and these hosts are long-lived processes where holding a SQLite
 * connection open for the life of the editor is a surprise the caller did not
 * ask for. Callers who want the audit_log projection pass their own
 * `receiptWriter`; passing `null` opts out entirely.
 *
 * Lazily constructed so a session that never triggers the guard never touches
 * the filesystem.
 */
function defaultInProcessReceiptWriter(options) {
  if (options.receiptWriter !== undefined) return options.receiptWriter;
  let writer = null;
  return {
    append(receipt) {
      const { createJsonlExternalActionReceiptWriter } = require('./external-action-receipt');
      if (!writer) writer = createJsonlExternalActionReceiptWriter({ path: options.receiptPath });
      return writer.append(receipt);
    },
  };
}

/**
 * In-process guards read the deployment's command policy for the same reason
 * they write receipts by default (#1794): the client a deployment happens to
 * use should not change what the gate does. Read per call, not per session,
 * so an edit to the policy file reaches a long-lived editor without a restart
 * -- the reader caches on mtime, so the usual cost is a stat.
 * `allowedCommands: []` opts out.
 */
function inProcessGuardOptions(base, options) {
  if (options.allowedCommands !== undefined) return base;
  return { ...base, allowedCommands: require('./external-action-command-policy').readAllowedCommands(options.policyPath) };
}

function createOpenCodeGuardPlugin(options = {}) {
  const guardOptions = { ...options, receiptWriter: defaultInProcessReceiptWriter(options) };
  return async function HuqanExternalActionGuardPlugin(context = {}) {
    return {
      'tool.execute.before': async (input, output) => {
        const evaluated = evaluateHookInvocation(EXTERNAL_ADAPTER_PROFILES.OPENCODE, { input: { ...input, cwd: context.directory }, output }, inProcessGuardOptions(guardOptions, options));
        if (evaluated.result.decision !== 'allow') {
          throw new Error(`HUQAN ${evaluated.result.decision}: ${evaluated.result.reason}`);
        }
      },
    };
  };
}

function registerPiGuard(pi, options = {}) {
  if (!pi || typeof pi.on !== 'function') throw new TypeError('registerPiGuard requires a Pi ExtensionAPI');
  const guardOptions = { ...options, receiptWriter: defaultInProcessReceiptWriter(options) };
  pi.on('tool_call', async (event, context = {}) => {
    const evaluated = evaluateHookInvocation(EXTERNAL_ADAPTER_PROFILES.PI, {
      event,
      sessionId: options.sessionId || context.sessionId || 'pi-session',
      cwd: options.cwd || context.cwd,
    }, inProcessGuardOptions(guardOptions, options));
    if (evaluated.result.decision !== 'allow') {
      return { block: true, reason: `HUQAN ${evaluated.result.decision}: ${evaluated.result.reason}` };
    }
    return undefined;
  });
}

module.exports = {
  EXTERNAL_ADAPTER_PROFILES,
  normalizeHookInvocation,
  projectHookDecision,
  evaluateHookInvocation,
  createOpenCodeGuardPlugin,
  registerPiGuard,
};
