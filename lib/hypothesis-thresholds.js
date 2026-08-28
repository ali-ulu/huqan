'use strict';

/**
 * Where an applied threshold lives.
 *
 * lib/hypothesis-tuning.js proposes a threshold change and stops. This is the
 * step that makes such a proposal stick — and it runs only when a person asks
 * for it by name (`hypotheses tuning --apply`). The engine still never writes
 * a threshold on its own; what changed is that a human now has somewhere to
 * put the decision other than a hand-edited source file.
 *
 * ## Refuse rather than repair
 *
 * A store that will not parse, or that holds a value `generateHypotheses`
 * would reject, fails closed. Silently resetting it would discard a decision
 * somebody made, and silently clamping it would run the engine on a threshold
 * nobody chose — both are worse than stopping and saying what is wrong.
 *
 * ## Precedence
 *
 * An explicit flag beats a stored value beats the default. A flag means "for
 * this run, use this"; treating it as weaker than the store would make
 * `--critical 7` quietly do nothing.
 */

const fs = require('fs');
const path = require('path');
const { siblingPersistencePath } = require('./memory-store-utils');
const { DEFAULTS } = require('./graph-hypotheses');

const STORE_SUFFIX = '.hypothesis-thresholds.json';
const STORE_VERSION = 1;

/** Mirrors the bounds boundedNumber() enforces inside generateHypotheses. */
const OPTION_BOUNDS = Object.freeze({
  confidenceFloor: Object.freeze({ min: 0, max: 1, integer: false }),
  criticalInDegree: Object.freeze({ min: 1, max: Number.POSITIVE_INFINITY, integer: true }),
  smallComponentSize: Object.freeze({ min: 2, max: Number.POSITIVE_INFINITY, integer: true }),
});

const OPTION_KEYS = Object.freeze(Object.keys(OPTION_BOUNDS));

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function thresholdStorePath(kernel) {
  const memoryPath = kernel?.graph?.memoryPath;
  if (typeof memoryPath !== 'string' || !memoryPath.trim()) {
    throw fail('HYPOTHESIS_THRESHOLDS_NO_STORE', 'The graph has no memory path to hang a threshold store off.');
  }
  return siblingPersistencePath(memoryPath, STORE_SUFFIX);
}

function readStore(storePath) {
  if (!fs.existsSync(storePath)) return { version: STORE_VERSION, workspaces: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch (error) {
    throw fail(
      'HYPOTHESIS_THRESHOLDS_UNREADABLE',
      `${storePath} could not be parsed (${error.message}); refusing to overwrite a decision that may be in there.`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.workspaces !== 'object' || !parsed.workspaces) {
    throw fail('HYPOTHESIS_THRESHOLDS_UNREADABLE', `${storePath} is not a threshold store.`);
  }
  return { version: parsed.version || STORE_VERSION, workspaces: parsed.workspaces };
}

function assertInRange(option, value, storePath) {
  const bounds = OPTION_BOUNDS[option];
  const invalid = !Number.isFinite(value)
    || value < bounds.min
    || value > bounds.max
    || (bounds.integer && !Number.isInteger(value));
  if (invalid) {
    throw fail(
      'HYPOTHESIS_THRESHOLDS_OUT_OF_RANGE',
      `${storePath} holds ${option}=${value}, which generateHypotheses would reject. `
        + 'Refusing rather than clamping: the engine must not run on a threshold nobody chose.',
    );
  }
}

/**
 * @returns {object} the stored overrides for one workspace; `{}` when none.
 * @throws when the store is unparseable or holds an out-of-range value.
 */
function readStoredThresholds(kernel, workspaceId = 'default') {
  const storePath = thresholdStorePath(kernel);
  const store = readStore(storePath);
  const scoped = store.workspaces[normalizeWorkspaceId(workspaceId)];
  if (!scoped || typeof scoped !== 'object') return {};

  const thresholds = {};
  for (const option of OPTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(scoped, option)) continue;
    assertInRange(option, scoped[option], storePath);
    thresholds[option] = scoped[option];
  }
  return thresholds;
}

/**
 * @param {object} stored overrides from readStoredThresholds
 * @param {object} flags per-run values; only finite numbers count as supplied
 */
function resolveThresholds(stored = {}, flags = {}) {
  const resolved = {};
  for (const option of OPTION_KEYS) {
    resolved[option] = Number.isFinite(flags[option])
      ? flags[option]
      : Number.isFinite(stored[option])
        ? stored[option]
        : DEFAULTS[option];
  }
  return resolved;
}

function writeStore(storePath, store) {
  const body = `${JSON.stringify({ version: STORE_VERSION, workspaces: store.workspaces }, null, 2)}\n`;
  const temporary = `${storePath}.tmp`;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(temporary, body);
  // Renamed into place so a crash mid-write cannot leave a half-written store
  // that the fail-closed read would then refuse on the next run.
  fs.renameSync(temporary, storePath);
}

/**
 * Persist the threshold changes a person asked for.
 *
 * @param {object} kernel
 * @param {string} workspaceId
 * @param {object[]} suggestions buildTuningAdvice().suggestions
 * @returns {{applied: object[], written: boolean, thresholds: object}}
 */
function applyThresholds(kernel, workspaceId, suggestions = []) {
  const scope = normalizeWorkspaceId(workspaceId);
  const storePath = thresholdStorePath(kernel);

  const applied = [];
  const evidence = [];
  for (const suggestion of suggestions) {
    if (!OPTION_BOUNDS[suggestion?.option]) continue;
    assertInRange(suggestion.option, suggestion.suggestedValue, storePath);
    applied.push({
      option: suggestion.option,
      ruleType: suggestion.ruleType,
      before: suggestion.currentValue,
      after: suggestion.suggestedValue,
    });
    evidence.push({
      ruleType: suggestion.ruleType,
      reviewed: suggestion.reviewed,
      rejectionRate: suggestion.rejectionRate,
    });
  }

  if (applied.length === 0) {
    return { applied: [], written: false, thresholds: readStoredThresholds(kernel, scope) };
  }

  const store = readStore(storePath);
  const scoped = { ...(store.workspaces[scope] || {}) };
  for (const change of applied) scoped[change.option] = change.after;
  store.workspaces[scope] = scoped;
  writeStore(storePath, store);

  // The evidence rides along with the change so "why is this threshold what it
  // is" is answerable from the trail alone, months later.
  kernel._appendAuditEvent?.({
    eventType: 'UPDATE',
    targetType: 'hypothesis_thresholds',
    targetId: scope,
    details: { workspaceId: scope, applied, evidence, storePath },
  }, null, scope);

  return { applied, written: true, thresholds: readStoredThresholds(kernel, scope) };
}

module.exports = {
  OPTION_BOUNDS,
  OPTION_KEYS,
  STORE_SUFFIX,
  applyThresholds,
  readStoredThresholds,
  resolveThresholds,
  thresholdStorePath,
};
