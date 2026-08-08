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

// Matched against the raw command text -- known-destructive shapes whose
// signal is the literal text itself, not the argument structure.
const DENYLIST_PATTERNS = Object.freeze([
  { name: 'fork_bomb', pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: 'pipe_to_shell', pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*)\b/i },
  { name: 'sudo', pattern: /(^|[;&|]|\s)sudo\s/i },
  { name: 'disk_format', pattern: /\b(mkfs(\.[a-z0-9]+)?|wipefs|shred)\b/i },
  { name: 'chmod_world_writable_root', pattern: /\bchmod\s+(-[a-z]*r[a-z]*\s+)?777\s+(\/|~)(\s|$)/i },
  { name: 'shutdown_or_reboot', pattern: /(^|[;&|]|\s)(shutdown|reboot|halt|poweroff)\b/i },
]);

// ─── Structural (tokenized) denylist checks ─────────────────────────────────
//
// `rm` and raw-disk writes are decided on the *argument structure*, not on a
// single text pattern (#379). The old single regex required the destructive
// flags to sit immediately before a literal `/` or `~`, so every one of these
// walked straight through it:
//
//   rm -rf --no-preserve-root /   flag between the flags and the target
//   rm -rf $HOME                  target is a variable, not `/` or `~`
//   rm -rf $(pwd)                 target is a substitution
//   cp file /dev/sda              raw disk write by a command other than dd
//
// These are decided over tokens instead, so flag order, interleaved flags,
// quoting and the choice of write command no longer matter.

// Wrappers that prefix a real command without changing what it does.
const COMMAND_WRAPPERS = new Set(['sudo', 'doas', 'command', 'time', 'nohup', 'eval', 'exec', 'nice', 'ionice', 'env', 'xargs']);

// Commands that can write to a block device given a path argument.
const RAW_DISK_WRITE_COMMANDS = new Set(['dd', 'cp', 'mv', 'tee', 'cat', 'shred', 'wipefs', 'parted', 'fdisk', 'sgdisk', 'mkfs']);

const RAW_DISK_DEVICE = /^\/dev\/(sd[a-z]|nvme\d+n\d+|hd[a-z]|disk\d+|vd[a-z]|mmcblk\d+)/i;

// Absolute paths whose recursive removal is never a scoped workspace action.
const CRITICAL_ROOTS = new Set([
  '/', '/bin', '/sbin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64',
  '/opt', '/proc', '/root', '/run', '/srv', '/sys', '/usr', '/var',
  '/Applications', '/Library', '/System', '/Users', '/Volumes',
]);

/**
 * Split a compound command line into individual command segments on shell
 * separators, so each segment can be inspected as its own invocation.
 */
function splitCommandSegments(commandText) {
  return String(commandText)
    .split(/\|\||&&|[;\n|&]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Whitespace-tokenize a single segment, stripping one level of quoting.
 * Quote stripping is deliberate: `rm -rf "$HOME"` must be seen as the
 * operand `$HOME`, not as a literal quoted string that looks inert.
 */
function tokenizeSegment(segment) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(segment)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined && token !== '') tokens.push(token);
  }
  return tokens;
}

/** Strip wrapper commands and `VAR=value` prefixes to reach the real command. */
function stripCommandWrappers(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
    if (COMMAND_WRAPPERS.has(baseCommandName(token))) { index += 1; continue; }
    break;
  }
  return tokens.slice(index);
}

/** `/usr/bin/rm` and `rm` are the same command for gate purposes. */
function baseCommandName(token) {
  return String(token || '').split(/[\\/]/).pop().toLowerCase();
}

/**
 * A target is dangerous when removing it recursively cannot be scoped to the
 * workspace. Unresolved expansions (`$HOME`, `$(pwd)`, backticks) count: the
 * gate sees literal text, so it cannot prove where they point, and a security
 * gate resolves that uncertainty by failing closed rather than by guessing.
 */
function isDangerousRemovalTarget(operand) {
  const target = String(operand || '').trim();
  if (!target) return false;

  // Any expansion or substitution -- value is unknowable from the text.
  if (/[$`]/.test(target)) return true;

  // Bare glob, or a glob directly under root/home.
  if (target === '*' || /^\/\*+$/.test(target) || /^~\/?\*+$/.test(target)) return true;

  const normalized = target.replace(/\/+$/, '') || '/';
  if (normalized === '.' || normalized === '..' || normalized === '~') return true;
  if (/^~\//.test(normalized) && normalized.split('/').filter(Boolean).length <= 1) return true;
  if (CRITICAL_ROOTS.has(normalized)) return true;

  return false;
}

/**
 * Detect a destructive `rm` in any segment. Returns true when the removal is
 * recursive against an unscopable target, or when `--no-preserve-root` is
 * present at all -- that flag exists only to defeat the very guard that stops
 * `rm -rf /`, so its presence is itself the signal.
 */
function findDestructiveRm(commandText) {
  for (const segment of splitCommandSegments(commandText)) {
    const tokens = stripCommandWrappers(tokenizeSegment(segment));

    // `rm` is located anywhere in the segment, not just at position 0. This
    // gate is also applied to free-form agent goals (see lib/mcp-gate-adapter),
    // where the command is embedded in prose -- "run rm -rf / to clean up".
    for (let index = 0; index < tokens.length; index += 1) {
      if (baseCommandName(tokens[index]) !== 'rm') continue;

      let recursive = false;
      let noPreserveRoot = false;
      const operands = [];

      for (const token of tokens.slice(index + 1)) {
        if (token === '--') continue;
        if (token.startsWith('--')) {
          const flag = token.toLowerCase();
          if (flag === '--recursive') recursive = true;
          if (flag === '--no-preserve-root') noPreserveRoot = true;
          continue;
        }
        if (token.startsWith('-') && token.length > 1) {
          // Short flag cluster: -r, -rf, -fr, -Rf ...
          if (/[rR]/.test(token.slice(1))) recursive = true;
          continue;
        }
        operands.push(token);
      }

      if (noPreserveRoot) return true;
      if (recursive && operands.some(isDangerousRemovalTarget)) return true;
    }
  }
  return false;
}

/** Detect a write to a raw block device by any write-capable command. */
function findRawDiskWrite(commandText) {
  for (const segment of splitCommandSegments(commandText)) {
    const tokens = stripCommandWrappers(tokenizeSegment(segment));

    // Same prose-embedding concern as findDestructiveRm: locate the write
    // command anywhere in the segment, then look at what follows it.
    for (let index = 0; index < tokens.length; index += 1) {
      if (!RAW_DISK_WRITE_COMMANDS.has(baseCommandName(tokens[index]))) continue;
      for (const token of tokens.slice(index + 1)) {
        // `dd of=/dev/sda` carries the target inside the operand.
        const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
        if (RAW_DISK_DEVICE.test(value)) return true;
      }
    }
  }
  // Redirection to a raw device, e.g. `echo x > /dev/sda`.
  return extractRedirectionTargets(commandText).some((target) => RAW_DISK_DEVICE.test(target));
}

// Structural checks run alongside the text patterns above. Names are kept
// stable so existing callers and receipts keep the same denylistMatch values.
const STRUCTURAL_DENYLIST_CHECKS = Object.freeze([
  { name: 'rm_rf_root_or_home', test: findDestructiveRm },
  { name: 'raw_disk_write', test: findRawDiskWrite },
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
  // Structural checks first: they carry the most specific signal, so an
  // `rm -rf /` reports `rm_rf_root_or_home` rather than a coincidental
  // text-pattern hit from elsewhere in the same command line.
  for (const check of STRUCTURAL_DENYLIST_CHECKS) {
    if (check.test(commandText)) return check.name;
  }
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
  findDestructiveRm,
  findRawDiskWrite,
  splitCommandSegments,
  tokenizeSegment,
  isDangerousRemovalTarget,
  findInjectionMatches,
  findOutOfWorkspaceTarget,
  evaluateCommandExec,
};
