'use strict';

/**
 * AB8 — Command Exec Gate.
 *
 * `tool-call-gate` (AB2) classifies actions by verb (read/write/destructive/
 * deploy/...) but has no notion of an OS command string at all, so
 * `exec("rm -rf /")` and `exec("ls")` both just look like a generic
 * "execute" action to it. This module adds the missing command-level check:
 * it inspects the literal command text for known-destructive commands,
 * shell-injection metacharacters, and (via lib/path-safety) any redirection
 * target that would write outside the caller's workspace root.
 *
 * Fail-closed by design: a denylisted command or an out-of-workspace write
 * target is BLOCK, not REVIEW. Shell-metacharacter chaining alone (no
 * denylist match) is REVIEW rather than BLOCK -- pipes and `&&` are common
 * in legitimate commands, so outright blocking them would just train
 * callers to strip the metacharacters rather than actually be safer.
 */
//
// #2181: vocabulary, command structure and target extraction live in
// command-exec-gate-*.js; this module evaluates a command and shapes the result.

const { extractRedirectionTargets, findDestructiveRm, findRawDiskWrite, isDangerousRemovalTarget, splitCommandSegments, tokenizeSegment } = require('./command-exec-gate-structure');
const { extractCommandText, findDenylistMatch, findInjectionMatches, findOutOfWorkspaceTarget } = require('./command-exec-gate-targets');
const { AB8_GATE_VERSION, COMMAND_EXEC_DECISIONS, COMMAND_EXEC_REASONS } = require('./command-exec-gate-vocabulary');

/**
 * Evaluates a single command-execution request. `input` may be a raw
 * command string, or an object carrying `{ command, cwd, workspaceRoot }`
 * (cwd is accepted for callers but only `workspaceRoot` is currently used
 * for path containment -- redirection targets are resolved against it the
 * same way lib/path-safety resolves file writes).
 */
function evaluateCommandExec(input) {
  const commandText = extractCommandText(input);
  const workspaceRoot = (input && typeof input === 'object') ? (input.workspaceRoot || input.cwd || null) : null;

  if (!commandText) {
    return buildResult(COMMAND_EXEC_DECISIONS.REVIEW, COMMAND_EXEC_REASONS.EMPTY_COMMAND, {
      commandText,
    });
  }

  const denylistMatch = findDenylistMatch(commandText);
  if (denylistMatch) {
    return buildResult(COMMAND_EXEC_DECISIONS.BLOCK, COMMAND_EXEC_REASONS.DENYLISTED_COMMAND_BLOCKED, {
      commandText,
      denylistMatch,
    });
  }

  const outOfWorkspaceTarget = findOutOfWorkspaceTarget(commandText, workspaceRoot);
  if (outOfWorkspaceTarget) {
    return buildResult(COMMAND_EXEC_DECISIONS.BLOCK, COMMAND_EXEC_REASONS.PATH_OUTSIDE_WORKSPACE_BLOCKED, {
      commandText,
      outOfWorkspaceTarget,
    });
  }

  const injectionMatches = findInjectionMatches(commandText);
  if (injectionMatches.length > 0) {
    return buildResult(COMMAND_EXEC_DECISIONS.REVIEW, COMMAND_EXEC_REASONS.SHELL_INJECTION_PATTERN_REVIEW, {
      commandText,
      injectionMatches,
    });
  }

  return buildResult(COMMAND_EXEC_DECISIONS.ALLOW, COMMAND_EXEC_REASONS.ALLOWED, { commandText });
}

function buildResult(decision, reason, details = {}) {
  return {
    ok: true,
    decision,
    allowed: decision === COMMAND_EXEC_DECISIONS.ALLOW,
    canExecute: decision === COMMAND_EXEC_DECISIONS.ALLOW,
    canDryRun: decision !== COMMAND_EXEC_DECISIONS.BLOCK,
    reason,
    denylistMatch: details.denylistMatch || null,
    injectionMatches: details.injectionMatches || [],
    outOfWorkspaceTarget: details.outOfWorkspaceTarget || null,
    gateVersion: AB8_GATE_VERSION,
  };
}

module.exports = {
  AB8_GATE_VERSION,
  COMMAND_EXEC_DECISIONS,
  COMMAND_EXEC_REASONS,
  extractCommandText,
  extractRedirectionTargets,
  findDenylistMatch,
  findDestructiveRm,
  findRawDiskWrite,
  splitCommandSegments,
  tokenizeSegment,
  isDangerousRemovalTarget,
  findInjectionMatches,
  findOutOfWorkspaceTarget,
  evaluateCommandExec,
};
