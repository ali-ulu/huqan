'use strict';

/**
 * The guard's own control plane.
 *
 * Every adapter profile in `external-action-adapter.js` is wired in by a config
 * file that lives inside the workspace it protects. That is the weak point: the
 * guard evaluates a write to `.claude/settings.json` with exactly the rules it
 * uses for `lib/anything.js`, so the file that decides whether the guard runs at
 * all is defended no harder than an ordinary source file. Under the Claude Code
 * profile a `review` becomes `ask` — the same prompt every other write raises —
 * and a single habitual approval removes the guard for every later action.
 *
 * These rules name those files so the guard can rank them above ordinary
 * workspace paths. Disarming the guard has to be a deliberate, separately
 * authorized act, not one more `ask` in a long day of them.
 *
 * Maintenance is a real need, so the block is not absolute: the hook accepts
 * `--allow-control-plane`, which comes from the deployment that installed the
 * hook. It is deliberately not readable from the invocation payload — an agent
 * must not be able to grant itself control-plane access by asking for it, the
 * same reason the identity card is attached from options in
 * `evaluateHookInvocation`.
 */

const CONTROL_PLANE_PATH_RULES = Object.freeze([
  { profile: 'claude-code', pattern: /(?:^|\/)\.claude\/(?:settings\.json|settings\.local\.json|hooks\.json|hooks\/.+)$/ },
  { profile: 'codex', pattern: /(?:^|\/)\.codex\/(?:hooks\.json|hooks\/.+)$/ },
  { profile: 'opencode', pattern: /(?:^|\/)\.opencode\/plugin\/.+$/ },
  { profile: 'pi', pattern: /(?:^|\/)\.pi\/extensions\/.+$/ },
  { profile: 'hermes', pattern: /(?:^|\/)\.hermes\/plugins\/.+$/ },
  { profile: 'huqan', pattern: /(?:^|\/)adapters\/external-action\/.+$/ },
]);

/**
 * Shell verbs that can replace, move or empty a file they are given.
 *
 * `sed` is absent on purpose: it only writes with `-i`, and is otherwise one of
 * the most common read-only ways to inspect a config. It is handled below.
 */
const MUTATING_SHELL_VERBS = new Set([
  'rm', 'unlink', 'shred', 'mv', 'cp', 'install', 'ln',
  'tee', 'truncate', 'dd', 'chmod', 'chown', 'touch', 'patch',
]);

/** Wrappers that prefix a real command without changing what it does. */
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'time', 'nohup', 'eval', 'exec', 'nice', 'ionice', 'env', 'xargs',
]);

function normalizeCandidate(candidate) {
  return String(candidate ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '');
}

/**
 * @returns {{profile: string}|null} the profile whose wiring this path is, or null.
 */
function isControlPlanePath(candidate) {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) return null;
  const rule = CONTROL_PLANE_PATH_RULES.find(entry => entry.pattern.test(normalized));
  return rule ? { profile: rule.profile, path: normalized } : null;
}

function tokenize(command) {
  return String(command ?? '').split(/[\s;&|]+/).filter(Boolean);
}

/**
 * Find a control-plane file that a shell command would modify.
 *
 * Reading the config is not a threat — `cat`, `grep` and `git diff` over
 * `.claude/settings.json` are how an operator checks the guard is wired in, and
 * flagging them would train people to approve control-plane prompts.
 *
 * @returns {{profile: string, path: string}|null}
 */
function findControlPlaneCommandTarget(command) {
  const tokens = tokenize(command);
  if (!tokens.length) return null;

  const verbs = [];
  let expectVerb = true;
  for (const token of tokens) {
    if (expectVerb && !token.startsWith('-')) {
      const verb = normalizeCandidate(token).split('/').pop();
      verbs.push(verb);
      expectVerb = false;
    }
    // A pipeline or list separator was consumed by tokenize, so the next bare
    // word after a redirect target is a fresh verb.
    if (token === '>' || token === '>>') expectVerb = true;
  }

  const mutates = verbs.some(verb => MUTATING_SHELL_VERBS.has(verb))
    || (verbs.includes('sed') && /(?:^|\s)-[a-z]*i/.test(String(command)))
    || />>?/.test(String(command));
  if (!mutates) return null;

  for (const token of tokens) {
    if (COMMAND_WRAPPERS.has(token)) continue;
    const match = isControlPlanePath(token);
    if (match) return match;
  }
  return null;
}

module.exports = {
  CONTROL_PLANE_PATH_RULES,
  MUTATING_SHELL_VERBS,
  isControlPlanePath,
  findControlPlaneCommandTarget,
};
