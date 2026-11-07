'use strict';

/**
 * The one directory HUQAN keeps its own machine-local state in.
 *
 * The external-action gate's receipt trail and command policy live here, and so
 * does the registry of known store paths. Redirecting it moves all of them at
 * once -- which is what a test run needs, so that a suite can never observe or
 * extend the operator's real policy and receipt chain (#1846).
 *
 * A leaf on purpose. It was part of external-action-receipt.js, which reaches
 * `../graph` for the file-effect sensor; anything downward of graph.js that
 * needed the state root therefore closed a require cycle
 * (graph -> sqlite-persistence-validation -> store-creation-guard ->
 * external-action-receipt -> graph). Nothing here requires anything but node
 * builtins, so both sides can depend on it downward.
 */

const os = require('node:os');
const path = require('node:path');

const STATE_ROOT_OVERRIDE_VARIABLE = 'HUQAN_STATE_ROOT';

/**
 * @param {object} [environment]
 * @returns {string} absolute path to the state root
 */
/**
 * The operator's explicit `HUQAN_STATE_ROOT`, resolved absolute -- or null when
 * the variable is absent or blank and the platform default applies (#4537).
 * Only an override may *move* a derived default such as the memory store: the
 * platform fallback is where receipts have always lived and must not start
 * collecting `memory.json` from every caller.
 */
function stateRootOverride(environment = process.env) {
  const override = typeof environment[STATE_ROOT_OVERRIDE_VARIABLE] === 'string'
    ? environment[STATE_ROOT_OVERRIDE_VARIABLE].trim()
    : '';
  return override ? path.resolve(override) : null;
}

function defaultStateRoot(environment = process.env) {
  const override = stateRootOverride(environment);
  if (override) return override;
  const base = process.platform === 'win32' && environment.LOCALAPPDATA
    ? environment.LOCALAPPDATA
    : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'huqan');
}

module.exports = {
  STATE_ROOT_OVERRIDE_VARIABLE,
  defaultStateRoot,
  stateRootOverride,
};
