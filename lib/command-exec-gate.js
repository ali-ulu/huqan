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

const path = require('path');
const { isPathWithinRoot } = require('./path-safety');

const AB8_GATE_VERSION = 'AB8-v0.1.0';

const COMMAND_EXEC_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
});

const COMMAND_EXEC_REASONS = Object.freeze({
  ALLOWED: 'ALLOWED',
  EMPTY_COMMAND: 'EMPTY_COMMAND',
  DENYLISTED_COMMAND_BLOCKED: 'DENYLISTED_COMMAND_BLOCKED',
  PATH_OUTSIDE_WORKSPACE_BLOCKED: 'PATH_OUTSIDE_WORKSPACE_BLOCKED',
  SHELL_INJECTION_PATTERN_REVIEW: 'SHELL_INJECTION_PATTERN_REVIEW',
});

// Deliberately matched against the raw command text (not tokenized) --
// these are known-destructive shapes, not full shell parsing.
const DENYLIST_PATTERNS = Object.freeze([
  { name: 'rm_rf_root_or_home', pattern: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(\/|~)(\s|$)/i },
  { name: 'fork_bomb', pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: 'pipe_to_shell', pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*)\b/i },
  { name: 'sudo', pattern: /(^|[;&|]|\s)sudo\s/i },
  { name: 'disk_format', pattern: /\bmkfs(\.[a-z0-9]+)?\b/i },
  { name: 'raw_disk_write', pattern: /\bdd\s+[^\n]*\bof=\/dev\/(sd|nvme|hd|disk)/i },
  { name: 'chmod_world_writable_root', pattern: /\bchmod\s+(-[a-z]*r[a-z]*\s+)?777\s+(\/|~)(\s|$)/i },
  { name: 'shutdown_or_reboot', pattern: /(^|[;&|]|\s)(shutdown|reboot|halt|poweroff)\b/i },
]);

// Shell metacharacters that enable command chaining / substitution. Present
// on their own (no denylist match) they only trigger REVIEW -- they are
// common in legitimate multi-step commands.
const INJECTION_PATTERNS = Object.freeze([
  { name: 'command_substitution', pattern: /\$\(/ },
  { name: 'backtick_substitution', pattern: /`/ },
  { name: 'command_chain_semicolon', pattern: /;/ },
  { name: 'command_chain_and', pattern: /&&/ },
]);

// Matches `> path` / `>> path` redirection targets so they can be checked
// against the workspace root. Intentionally does not attempt full shell
// tokenizing (quoting, globbing) -- this is a best-effort extraction over
// the literal command text.
const REDIRECTION_TARGET_PATTERN = />{1,2}\s*("([^"]+)"|'([^']+)'|(\S+))/g;

function toText(value) {
  return String(value ?? '').trim();
}

function extractCommandText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  return toText(
    input.command ?? input.cmd ?? input.shell ?? input.script ?? input.exec ?? ''
  );
}

function findDenylistMatch(commandText) {
  for (const entry of DENYLIST_PATTERNS) {
    if (entry.pattern.test(commandText)) return entry.name;
  }
  return null;
}

function findInjectionMatches(commandText) {
  const matches = [];
  for (const entry of INJECTION_PATTERNS) {
    if (entry.pattern.test(commandText)) matches.push(entry.name);
  }
  return matches;
}

function extractRedirectionTargets(commandText) {
  const targets = [];
  let match;
  REDIRECTION_TARGET_PATTERN.lastIndex = 0;
  while ((match = REDIRECTION_TARGET_PATTERN.exec(commandText)) !== null) {
    const target = match[2] ?? match[3] ?? match[4];
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Checks any redirection targets (`> path`, `>> path`) in `commandText`
 * against `workspaceRoot` using the same path-containment logic path-safety
 * uses for file writes. Returns the first offending target, or null if
 * every target (or no target) is within the workspace.
 */
function findOutOfWorkspaceTarget(commandText, workspaceRoot) {
  if (!workspaceRoot) return null;
  const targets = extractRedirectionTargets(commandText);
  for (const target of targets) {
    // A relative target (e.g. "out.txt") means "relative to the command's
    // own working directory", which for a sandboxed command is the
    // workspace root -- not this process's cwd, which is what
    // isPathWithinRoot would resolve against if handed the bare target.
    const resolvedTarget = path.resolve(workspaceRoot, target);
    if (!isPathWithinRoot(workspaceRoot, resolvedTarget)) return target;
  }
  return null;
}

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
  findInjectionMatches,
  findOutOfWorkspaceTarget,
  evaluateCommandExec,
};
