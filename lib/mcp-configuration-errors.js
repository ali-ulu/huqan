'use strict';

const { ENVIRONMENT_SUFFIXES } = require('./environment-compat');
const { DEFAULT_CAPABILITIES } = require('./kernel-contract');

/**
 * Telling a misconfiguration apart from a crash, at the MCP boundary.
 *
 * `tools/call` answers every uncaught exception with `INTERNAL_ERROR (ref: …)`
 * and writes the detail to stderr (#413, lib/mcp-envelope-format.js). That is
 * right for a fault: `err.message` on an unexpected throw carries filesystem
 * paths, driver codes and internal identifiers, and an MCP client is not a
 * trusted operator console.
 *
 * It is wrong for a *declared* outcome. A stale `HUQAN_AGENT_VERSION` in a
 * Claude Desktop config makes every `huqan.agent` call answer
 * `INTERNAL_ERROR (ref: 1b805f30)` while the sentence that would fix it --
 * "version selection has been removed" -- goes to a stderr stream that surface
 * never shows anyone. Nothing is crashing; the server is being asked for
 * something its configuration forbids, and it knows exactly what.
 *
 * `lib/http/read-workflow-actions.js` answers this at one call site by
 * pre-checking kernel state before `runCapability()`, which is the better fix
 * where it applies: a pre-check can say *why* in the workflow's own words, and
 * it leaves genuine faults inside the capability surfacing as faults. This
 * module is the backstop for the paths no pre-check guards -- environment
 * validation that runs mid-request, deep inside `createAgent()`.
 *
 * Two rules keep the #413 property intact:
 *
 * 1. **`err.message` is never relayed.** The text comes from the table below,
 *    which is written here, not by the throwing layer. A future error that
 *    reuses one of these codes with a leaky message cannot leak through it.
 * 2. **Interpolated values are validated against a closed set first.**
 *    Environment variable names must be spellings of a known
 *    `ENVIRONMENT_SUFFIXES` entry; capability names must be keys of
 *    `DEFAULT_CAPABILITIES`. Anything else falls back to the unparameterised
 *    sentence rather than echoing an attacker- or operator-supplied string.
 *
 * A code reaches this table only when it is deterministic, caused by
 * configuration rather than by state, and fixable by the person reading the
 * response. Codes that are startup-only (`HUQAN_SQLITE_UNAVAILABLE`,
 * `HUQAN_KERNEL_VERSION_UNSUPPORTED` -- both thrown while the kernel is being
 * built, before `handleRequest` exists) are deliberately absent: entries here
 * would be unreachable, and an unreachable branch that claims to classify
 * errors is worse than no branch.
 */

const ENVIRONMENT_VARIABLE_NAMES = new Set(
  ENVIRONMENT_SUFFIXES.flatMap(suffix => [`HUQAN_${suffix}`, `AXIOM_${suffix}`]),
);

const CAPABILITY_NAMES = new Set(Object.keys(DEFAULT_CAPABILITIES));

function knownEnvironmentVariable(name) {
  return typeof name === 'string' && ENVIRONMENT_VARIABLE_NAMES.has(name);
}

function knownCapability(name) {
  return typeof name === 'string' && CAPABILITY_NAMES.has(name);
}

const CONFIGURATION_ERRORS = Object.freeze({
  HUQAN_ENV_CONFLICT(err) {
    const canonical = err && err.canonicalName;
    const legacy = err && err.legacyName;
    if (knownEnvironmentVariable(canonical) && knownEnvironmentVariable(legacy)) {
      return `${canonical} and ${legacy} are both set, to different values. `
        + 'Unset one so this surface reads a single configuration.';
    }
    return 'Two spellings of one HUQAN environment variable are set to different values. '
      + 'Unset one so this surface reads a single configuration.';
  },

  HUQAN_AGENT_VERSION_UNSUPPORTED() {
    return 'An agent version was requested through HUQAN_AGENT_VERSION, and version '
      + 'selection has been removed. Unset it so this surface uses the canonical agent.';
  },

  CAPABILITY_REQUIRED(err) {
    const capability = err && err.capability;
    if (knownCapability(capability)) {
      return `This surface does not enable the "${capability}" capability, which this tool needs.`;
    }
    return 'This surface does not enable a capability that this tool needs.';
  },
});

/**
 * @returns {{code: string, message: string}|null} null for anything that is not
 *   an allowlisted configuration error -- the caller must keep treating those
 *   as internal errors.
 */
function describeConfigurationError(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (!Object.hasOwn(CONFIGURATION_ERRORS, code)) return null;
  return { code, message: CONFIGURATION_ERRORS[code](err) };
}

function configurationErrorEnvelope({ code, message }) {
  return {
    ok: false,
    type: 'configuration',
    data: null,
    evidence: [],
    error: { code, message },
    meta: { configuration: true },
  };
}

/**
 * The operator still gets a stderr line, because a request failing on
 * configuration is worth noticing. Only the code is logged: unlike an internal
 * error there is no detail the client was denied, so there is nothing for a
 * reference number to correlate.
 */
function recordConfigurationError(scope, code) {
  try {
    console.error(`[mcp][${scope}] configuration error code=${code}`);
  } catch (_) {
    // Diagnostics are best-effort; the response the caller is waiting for is not.
  }
}

module.exports = {
  CONFIGURATION_ERROR_CODES: Object.freeze(Object.keys(CONFIGURATION_ERRORS)),
  describeConfigurationError,
  configurationErrorEnvelope,
  recordConfigurationError,
};
