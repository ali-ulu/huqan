'use strict';

// #2181: what a command matches and where it writes -- denylist and
// injection matches, redirection and write-command destinations, and the
// first target outside the workspace root.

const path = require('path');
const { isPathWithinRoot } = require('./path-safety');
const { INJECTION_PATTERNS, STRUCTURAL_DENYLIST_CHECKS, baseCommandName, extractRedirectionTargets, resolveOperandPath, splitCommandSegments, stripCommandWrappers, toText, tokenizeSegment } = require('./command-exec-gate-structure');
const { DENYLIST_PATTERNS } = require('./command-exec-gate-vocabulary');

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

/**
 * Where each write command keeps its *destination* operand.
 *
 * Only destinations are collected. `cp /etc/hosts ./local` reads from outside
 * the workspace and writes inside it, which the gate has no reason to block;
 * taking every operand would turn that ordinary command into a BLOCK.
 */
const WRITE_COMMAND_DESTINATIONS = Object.freeze({
  cp: 'last', mv: 'last', install: 'last', ln: 'last', rsync: 'last',
  tee: 'all', touch: 'all', mkdir: 'all',
  dd: 'of=',
});

/**
 * Destination operands of write commands, e.g. the `/etc/passwd` in
 * `cp secret /etc/passwd`.
 *
 * The gate's header promises that "an out-of-workspace write target is BLOCK",
 * and that held only for redirections. A direct write-command operand -- the
 * more common shape, and the one `cp secret /etc/passwd`,
 * `tee /etc/cron.d/backdoor` and `install -m 644 evil /etc/systemd/system/`
 * all use -- was never path-checked at all (#1145).
 */
function extractWriteCommandDestinations(commandText) {
  const destinations = [];
  for (const segment of splitCommandSegments(commandText)) {
    const tokens = stripCommandWrappers(tokenizeSegment(segment));
    for (let index = 0; index < tokens.length; index += 1) {
      const where = WRITE_COMMAND_DESTINATIONS[baseCommandName(tokens[index])];
      if (!where) continue;

      const rest = tokens.slice(index + 1);
      if (where === 'of=') {
        for (const token of rest) {
          if (/^of=/i.test(token)) destinations.push(token.slice(3));
        }
        continue;
      }

      const operands = rest.filter((token) => !(token.startsWith('-') && token.length > 1));
      if (operands.length === 0) continue;
      if (where === 'last') {
        // A single operand is `touch x`-shaped: it is the destination. With
        // two or more, the last one is, and the rest are sources.
        destinations.push(operands[operands.length - 1]);
      } else {
        destinations.push(...operands);
      }
    }
  }
  return destinations;
}

/**
 * Checks redirection targets (`> path`, `>> path`) and write-command
 * destinations in `commandText` against `workspaceRoot`, using the same
 * path-containment logic path-safety uses for file writes. Returns the first
 * offending target, or null if every target (or no target) is within the
 * workspace.
 */
function findOutOfWorkspaceTarget(commandText, workspaceRoot) {
  if (!workspaceRoot) return null;
  const targets = [
    ...extractRedirectionTargets(commandText),
    ...extractWriteCommandDestinations(commandText),
  ];
  for (const rawTarget of targets) {
    // An unresolvable expansion is not a path this check can reason about;
    // findDestructiveRm already fails closed on those for removals, and
    // treating them as containment violations here would block ordinary
    // `cp x "$OUT"` inside the workspace.
    if (/[$`]/.test(rawTarget)) continue;
    const target = resolveOperandPath(rawTarget) || rawTarget;
    // A relative target (e.g. "out.txt") means "relative to the command's
    // own working directory", which for a sandboxed command is the
    // workspace root -- not this process's cwd, which is what
    // isPathWithinRoot would resolve against if handed the bare target.
    const resolvedTarget = path.resolve(workspaceRoot, target);
    if (!isPathWithinRoot(workspaceRoot, resolvedTarget)) return target;
  }
  return null;
}

module.exports = {
  extractCommandText,
  findDenylistMatch,
  findInjectionMatches,
  findOutOfWorkspaceTarget,
};
