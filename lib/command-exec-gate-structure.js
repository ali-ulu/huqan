'use strict';

// #2181: reading a command's structure -- segments, tokens, wrappers, base
// names, redirection targets -- to find destructive rm and raw disk writes
// by shape, not text.

const path = require('path');
const { COMMAND_WRAPPERS, CRITICAL_ROOTS, CRITICAL_SYSTEM_ROOTS, RAW_DISK_DEVICE, RAW_DISK_WRITE_COMMANDS } = require('./command-exec-gate-vocabulary');

/**
 * Resolve an operand the way the shell and the kernel would, so the gate
 * compares paths rather than spellings.
 *
 * Without this, every spelling of the root directory other than the two literal
 * ones in the set walked through: `\/`, `/.`, `/./`, `/etc/..` and `/home/../`
 * all name `/`, and `rm -rf /.` removes the root's contents exactly as
 * `rm -rf /` does. `/dev/./sda` is likewise the same file as `/dev/sda` (#1110,
 * #1111).
 *
 * Only shell-inert transformations are applied -- unescaping and `.`/`..`
 * resolution. Expansions (`$HOME`, backticks) are deliberately *not* resolved;
 * callers treat an unresolvable operand as dangerous, which is the fail-closed
 * answer and must stay that way.
 */
function resolveOperandPath(operand) {
  const unescaped = String(operand || '').replace(/\\(.)/g, '$1').trim();
  if (!unescaped) return '';
  if (!unescaped.startsWith('/')) return unescaped.replace(/\/+$/, '') || unescaped;
  // posix.normalize collapses `.`, `..` and duplicate separators; it leaves a
  // trailing slash, which is stripped so `/etc/` and `/etc` compare equal.
  const normalized = path.posix.normalize(unescaped);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** True for a critical root, and for anything beneath a critical *system* root. */
function isCriticalPath(resolved) {
  if (resolved === '/') return true;
  if (CRITICAL_ROOTS.has(resolved)) return true;
  return CRITICAL_SYSTEM_ROOTS.some((root) => resolved.startsWith(`${root}/`));
}

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

/**
 * Strip wrapper commands and `VAR=value` prefixes to reach the real command.
 *
 * #4072: an interpreter wrapper is different from a plain wrapper -- its next
 * argument is a command *string*, not a command name. `sh -c "rm -rf /"`
 * tokenizes the quoted payload to a single token, so after stripping `sh`
 * the tokens are `['-c', 'rm -rf /']` and no denylist entry ever matches.
 * When the wrapper carries an exec banner, the banner, its flags and the
 * payload are replaced with the re-tokenized payload so the structural
 * denylist checks run on the inner command's own tokens.
 */
function stripCommandWrappers(tokens) {
  const unwrapped = [...tokens];
  let index = 0;
  while (index < unwrapped.length) {
    const token = unwrapped[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
    if (COMMAND_WRAPPERS.has(baseCommandName(token))) {
      const payloadIndex = interpreterPayloadStart(unwrapped, index);
      if (payloadIndex >= 0) {
        // Nested payloads unwind in the same pass: `sh -c 'bash -c "rm -rf /"'`
        // splices to interpreter tokens again, which the loop then unwraps.
        unwrapped.splice(index, payloadIndex - index + 1, ...interpreterPayloadTokens(unwrapped[payloadIndex]));
        continue;
      }
      index += 1;
      continue;
    }
    break;
  }
  return unwrapped.slice(index);
}

/** `/usr/bin/rm` and `rm` are the same command for gate purposes. */
function baseCommandName(token) {
  return String(token || '').split(/[\\/]/).pop().toLowerCase();
}

// Exec-banner flag (`-c`, `-lc`, `-e`, `-ec`) after which an interpreter takes
// the payload as its next argument. Without a banner the interpreter reads
// a script file or stdin and there is no single payload token to unwrap.
const INTERPRETER_EXEC_BANNER = /-[a-z]*[ce]/;

/**
 * Index of the payload token for the interpreter wrapper at `tokens[index]`,
 * or -1 when there is no exec-banner payload form here.
 */
function interpreterPayloadStart(tokens, index) {
  let cursor = index + 1;
  let banner = false;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (!token.startsWith('-') || token === '-') break;
    if (INTERPRETER_EXEC_BANNER.test(token)) banner = true;
    cursor += 1;
  }
  return banner && cursor < tokens.length ? cursor : -1;
}

/**
 * Tokenize an interpreter payload for the denylist checks.
 *
 * The shell expands `${IFS}` (and bare `$IFS`) to a field separator before
 * the payload tokenizes, so `sh -c rm${IFS}-rf${IFS}/` is `rm -rf /` to the
 * interpreter. Any other expansion stays literal: isDangerousRemovalTarget
 * already fails closed on `$`, and guessing at more is out of scope.
 */
function interpreterPayloadTokens(payload) {
  return tokenizeSegment(String(payload).replace(/\$\{?IFS\}?/g, ' '));
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

  const normalized = resolveOperandPath(target) || '/';
  if (normalized === '.' || normalized === '..' || normalized === '~') return true;
  if (/^~\//.test(normalized) && normalized.split('/').filter(Boolean).length <= 1) return true;
  if (isCriticalPath(normalized)) return true;

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
        if (isRawDiskDevice(value)) return true;
      }
    }
  }
  // Redirection to a raw device, e.g. `echo x > /dev/sda`.
  return extractRedirectionTargets(commandText).some(isRawDiskDevice);
}

/** Resolve first, then match: `/dev/./sda` is the same file as `/dev/sda`. */
function isRawDiskDevice(value) {
  return RAW_DISK_DEVICE.test(resolveOperandPath(value));
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
 * First redirection target that cannot be containment-checked because no
 * workspace root reached the gate: absolute (`/...`) or home (`~/...`)
 * targets. Relative targets resolve against the command's own working
 * directory and stay untouched; expansions are skipped the same way
 * findOutOfWorkspaceTarget skips them (#4072 followup).
 */
function findUncontainedRedirectTarget(commandText) {
  for (const rawTarget of extractRedirectionTargets(commandText)) {
    if (/[$`]/.test(rawTarget)) continue;
    if (/^[~\\/]/.test(rawTarget)) return rawTarget;
  }
  return null;
}

module.exports = {
  INJECTION_PATTERNS,
  STRUCTURAL_DENYLIST_CHECKS,
  baseCommandName,
  extractRedirectionTargets,
  findDestructiveRm,
  findRawDiskWrite,
  findUncontainedRedirectTarget,
  isDangerousRemovalTarget,
  resolveOperandPath,
  splitCommandSegments,
  stripCommandWrappers,
  toText,
  tokenizeSegment,
};
