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
      metadata: { permissionMode: payload.permission_mode },
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
    return {
      exitCode: 0,
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
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
    },
  };
}

function evaluateHookInvocation(profile, payload, options = {}) {
  const invocation = normalizeHookInvocation(profile, payload, options);
  const result = evaluateExternalAction(invocation, options);
  return { invocation, result, projection: projectHookDecision(profile, result) };
}

function createOpenCodeGuardPlugin(options = {}) {
  return async function HuqanExternalActionGuardPlugin(context = {}) {
    return {
      'tool.execute.before': async (input, output) => {
        const evaluated = evaluateHookInvocation(EXTERNAL_ADAPTER_PROFILES.OPENCODE, { input: { ...input, cwd: context.directory }, output }, options);
        if (evaluated.result.decision !== 'allow') {
          throw new Error(`HUQAN ${evaluated.result.decision}: ${evaluated.result.reason}`);
        }
      },
    };
  };
}

function registerPiGuard(pi, options = {}) {
  if (!pi || typeof pi.on !== 'function') throw new TypeError('registerPiGuard requires a Pi ExtensionAPI');
  pi.on('tool_call', async (event, context = {}) => {
    const evaluated = evaluateHookInvocation(EXTERNAL_ADAPTER_PROFILES.PI, {
      event,
      sessionId: options.sessionId || context.sessionId || 'pi-session',
      cwd: options.cwd || context.cwd,
    }, options);
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
