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
 * canonically serialized arguments. The interceptor chain between the
 * decision and the handler (gate evaluation, the human-approval toggle,
 * telemetry) must not change the arguments; the dispatcher re-checks the
 * binding before the handler runs, and an approval executes only the
 * arguments its reviewer saw.
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

function argsDigest(args) {
  return hashCanonicalPayload(args && typeof args === 'object' ? args : {});
}

function bindCall(tool, args) {
  return Object.freeze({ tool, argsDigest: argsDigest(args) });
}

/** Whether `binding` still describes this exact tool and these arguments. */
function bindingHolds(binding, tool, args) {
  return Boolean(binding)
    && binding.tool === tool
    && binding.argsDigest === argsDigest(args);
}

module.exports = Object.freeze({
  SEP_986_TOOL_NAME,
  isSep986ToolName,
  namesConform,
  bindCall,
  bindingHolds,
});
