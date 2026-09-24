// #2151: classifying what a tool call would do -- read, write, destructive,
// deploy, side effect -- from its name, arguments and target locations.

const { containsWholeTerm } = require('./text-utils');
const { isPlainObject } = require('./is-plain-object');
const { toText } = require('./tool-call-gate-normalize');
const { DEPLOY_ACTIONS, DESTRUCTIVE_ACTIONS, NETWORK_MUTATION_HINTS, READ_ONLY_ACTIONS, SIDE_EFFECT_ACTIONS, TOOL_GATE_DECISIONS, TOOL_GATE_REASONS, WRITE_ACTIONS } = require('./tool-call-gate-vocabulary');

function hasAnyToken(text, tokens) {
  const norm = toText(text);
  return tokens.some(token => containsWholeTerm(norm, toText(token)));
}

/**
 * The words in an identifier, at token boundaries.
 *
 * `github.get_issue` and `getIssue` both yield ['get', 'issue']; `target`
 * yields ['target'] and never 'get'. Escalation may keep matching loose
 * substrings -- over-reading a hint can only raise a decision -- but the
 * read-only allow has to be granted per word, or a byte sequence buried in an
 * unrelated identifier hands out authority (#764).
 */
function tokenizeIdentifier(text) {
  const spaced = String(text ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return toText(spaced).split(/[^a-z0-9]+/).filter(Boolean);
}

function hasExactAction(tokens, actions) {
  const present = new Set(tokens);
  return actions.some(action => present.has(toText(action)));
}

function stringifyForSearch(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

/**
 * Argument keys whose value names *where* something is, not *what is being
 * done to it*.
 */
const LOCATION_KEYS = new Set([
  'file_path', 'filepath', 'path', 'targetpath', 'target_path', 'destination',
  'dir', 'directory', 'cwd', 'workspaceroot', 'workspace_root',
  'notebook_path', 'notebookpath', 'output_path', 'outputpath',
]);
const PATH_SEPARATOR = /[\\/]/;

function isLocationKey(key) {
  return LOCATION_KEYS.has(toText(key).replace(/[^a-z0-9_]/g, ''));
}

/** The last segment of a location value; anything else is returned as it is. */
function locationName(value, key) {
  if (typeof value !== 'string' || !isLocationKey(key)) return value;
  const segments = value.split(PATH_SEPARATOR).filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 1] : value;
}

/**
 * Escalation reads the whole call loosely on purpose -- over-reading a hint
 * can only raise a decision, never lower one (#764) -- and that stays. What
 * changes is what counts as a hint at all: the directories a file happens to
 * sit in are not a claim about the action.
 *
 * Measured: reading `C:\...\wt-ship\README.md` came out `dry_run_only`
 * because a path segment was the word `ship`, while the same call under
 * `wt-base` was `allow` -- same tool, same action, same file, the folder
 * decided (#1804). A directory named `deploy`, `release` or `publish` is
 * ordinary, and where a repository is checked out is not evidence. The file's
 * own name still is: `deploy.sh` accuses as before, and command, body and URL
 * fields are untouched.
 */
function searchableArgs(value, key = '') {
  if (Array.isArray(value)) return value.map(item => searchableArgs(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const [nested, item] of Object.entries(value)) out[nested] = searchableArgs(item, nested);
    return out;
  }
  return locationName(value, key);
}

function buildSearchText(normalized) {
  return [
    normalized.action,
    normalized.toolName,
    searchableArgs(normalized.args),
    normalized.raw?.input,
    normalized.raw?.request,
    normalized.raw?.body,
    normalized.raw?.payload,
    normalized.raw?.method,
    normalized.raw?.url,
  ].map(stringifyForSearch).filter(Boolean).join(' ');
}

function classifyAction(normalized) {
  const combined = buildSearchText(normalized);
  // Identity only: what the call says it is, never what it carries. Payload
  // text can accuse a call (the escalation branches below read `combined`),
  // but it must not be able to vouch for one (#764).
  const identityTokens = tokenizeIdentifier(`${normalized.actionRaw || normalized.action} ${normalized.toolName}`);

  if (!combined) {
    return {
      category: 'unknown',
      level: 'unknown',
      score: 0.5,
      reason: TOOL_GATE_REASONS.UNKNOWN_ACTION_REVIEW_REQUIRED,
      decision: TOOL_GATE_DECISIONS.REVIEW,
    };
  }

  if (hasAnyToken(combined, DESTRUCTIVE_ACTIONS)) {
    return {
      category: 'destructive',
      level: 'critical',
      score: 1,
      reason: TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED,
      decision: TOOL_GATE_DECISIONS.BLOCK,
    };
  }

  if (hasAnyToken(combined, DEPLOY_ACTIONS)) {
    return {
      category: 'deploy',
      level: 'high',
      score: 0.85,
      reason: TOOL_GATE_REASONS.HIGH_RISK_ACTION_DRY_RUN_ONLY,
      decision: TOOL_GATE_DECISIONS.DRY_RUN_ONLY,
    };
  }

  if (hasAnyToken(combined, NETWORK_MUTATION_HINTS)) {
    return {
      category: 'external_side_effect',
      level: 'high',
      score: 0.85,
      reason: TOOL_GATE_REASONS.EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED,
      decision: TOOL_GATE_DECISIONS.REVIEW,
    };
  }

  if (hasAnyToken(combined, WRITE_ACTIONS)) {
    return {
      category: 'write',
      level: 'medium',
      score: 0.6,
      reason: TOOL_GATE_REASONS.REVIEW_REQUIRED,
      decision: TOOL_GATE_DECISIONS.REVIEW,
    };
  }

  if (hasAnyToken(combined, SIDE_EFFECT_ACTIONS)) {
    return {
      category: 'external_side_effect',
      level: 'high',
      score: 0.8,
      reason: TOOL_GATE_REASONS.EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED,
      decision: TOOL_GATE_DECISIONS.REVIEW,
    };
  }

  if (hasExactAction(identityTokens, READ_ONLY_ACTIONS)) {
    return {
      category: 'read',
      level: 'low',
      score: 0.2,
      reason: TOOL_GATE_REASONS.LOW_RISK_ACTION,
      decision: TOOL_GATE_DECISIONS.ALLOW,
    };
  }

  return {
    category: 'unknown',
    level: 'medium',
    score: 0.55,
    reason: TOOL_GATE_REASONS.UNKNOWN_ACTION_REVIEW_REQUIRED,
    decision: TOOL_GATE_DECISIONS.REVIEW,
  };
}

module.exports = {
  classifyAction,
  locationName,
};
