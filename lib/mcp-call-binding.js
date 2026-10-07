'use strict';

/**
 * Tool-name rule and decision binding for MCP calls (#3488).
 *
 * Name. SEP-986 bounds a tool name to 1-128 characters from
 * `A-Za-z0-9._-`. HUQAN used to sanitize the requested name instead
 * (trim, strip control characters), so `" huqan.status "` or
 * `"huqan.status\u0000"` silently ran `huqan.status`. A name outside the
 * rule is now refused before anything resolves it. Every published name is
 * checked too, and the published set must sit in the server's own dotted
 * namespace (`huqan.<tool>`, legacy `axiom.<tool>`).
 *
 * Binding. A gate decision is about one target with one set of arguments.
 * `bindCall` records which: the canonical tool and a sha256 of the
 * canonically serialized arguments. Two uses, over different data:
 *
 * - `gate.binding` covers the raw arguments the gate decided on. The
 *   dispatcher re-checks it before the handler runs, so the in-process
 *   interceptor chain (gate evaluation, the human-approval toggle,
 *   telemetry) cannot change them unnoticed.
 * - `policy.reviewedBinding` on an approval row covers the sanitized
 *   arguments the reviewer is shown. Executing the approval re-checks the
 *   arguments it will run, and the stored `input` when that is their JSON.
 *
 * What this is not: the digest is unkeyed and lives in the same row as the
 * arguments, so it catches drift between what was reviewed and what would
 * run (a partial update, one column rewritten) but not a writer who rewrites
 * the arguments and the digest together, or strips the binding. That needs
 * a keyed seal outside the row.
 */

const { hashCanonicalPayload } = require('./hash-chain');

const SEP_986_TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function isSep986ToolName(name) {
  return typeof name === 'string' && SEP_986_TOOL_NAME.test(name);
}

/** True when every name is SEP-986 valid and inside one of the namespaces. */
function namesConform(names, namespaces) {
  return names.every(name => isSep986ToolName(name)
    && namespaces.some(prefix => name.startsWith(prefix) && name.length > prefix.length));
}

// The canonical serialization writes NaN and ±Infinity as null, so they would
// share a digest with null. A value JSON cannot carry has no canonical form.
function assertFiniteNumbers(value, seen = new Set()) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('call arguments contain a non-finite number');
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) assertFiniteNumbers(child, seen);
}

function argsDigest(args) {
  const payload = args && typeof args === 'object' ? args : {};
  assertFiniteNumbers(payload);
  return hashCanonicalPayload(payload);
}

function bindCall(tool, args) {
  return Object.freeze({ tool, argsDigest: argsDigest(args) });
}

/** Whether `binding` still describes this exact tool and these arguments. */
function bindingHolds(binding, tool, args) {
  if (!binding || binding.tool !== tool) return false;
  try {
    return binding.argsDigest === argsDigest(args);
  } catch (_) {
    // Arguments that lost their canonical form no longer match anything.
    return false;
  }
}

/**
 * The binding stored on an approval row. `inputIsArgs` says the row's
 * `input` column is the JSON of the same arguments, so it is checked too.
 */
function bindReviewedCall(tool, args, { inputIsArgs = false } = {}) {
  return Object.freeze({ ...bindCall(tool, args), inputIsArgs: inputIsArgs === true });
}

/** Whether an approval row still carries the arguments its binding names. */
function reviewedArgsHold(binding, tool, row, parseInput) {
  const context = row && row.context && typeof row.context === 'object' ? row.context : {};
  const args = context.args && typeof context.args === 'object' ? context.args : null;
  if (args === null || !bindingHolds(binding, tool, args)) return false;
  return binding.inputIsArgs !== true || bindingHolds(binding, tool, parseInput(row.input));
}

module.exports = Object.freeze({
  SEP_986_TOOL_NAME,
  isSep986ToolName,
  namesConform,
  bindCall,
  bindingHolds,
  bindReviewedCall,
  reviewedArgsHold,
});
