'use strict';

/**
 * Package root export.
 *
 * #329 (arch-4) made KernelV2 + AgentV3 the canonical runtime and removed
 * runtime version selection, but `package.json` still pointed `main` at
 * kernel.js — so the product had one runtime and two public kernel surfaces:
 * every entry point built a KernelV2 while `require('huqan')` handed out the
 * v1 Kernel. This file closes that gap.
 *
 * The root export is KernelV2. The v1 Kernel stays reachable under an
 * explicitly deprecated name so consumers that genuinely depend on it are not
 * broken abruptly; it is no longer the default and no longer a runtime option.
 * The deprecation lives in JSDoc, the type declarations and the docs — not in
 * a runtime `console.warn`, so importing this library stays free of side
 * effects. `KernelV1` can be removed in the next major release.
 *
 * Note on CommonJS mechanics: `module.exports = KernelV2` followed by property
 * assignment attaches those properties to the KernelV2 class object itself, so
 * they are visible through `require('./kernel.v2')` too. That is inherent to
 * the `export = Class` idiom and is why the names below are deliberately
 * specific rather than generic.
 */

const Kernel = require('./kernel');
const KernelV2 = require('./kernel.v2');
const errorPrevention = require('./lib/error-prevention');
const agentActionFirewall = require('./lib/agent-action-firewall');

module.exports = KernelV2;

module.exports.KernelV2 = KernelV2;

/** @deprecated Use KernelV2 / require('huqan'). Removed in the next major. */
module.exports.KernelV1 = Kernel;

// These four were part of the published surface while `main` was kernel.js:
// `require('huqan').ProvenanceError` and
// `require('huqan').createAdmissionBypassOpts(...)` are live call patterns, and
// `error instanceof require('huqan').ProvenanceError` has to keep matching the
// errors the kernel actually throws. Forwarding the same objects (not copies)
// keeps those identity checks true.
module.exports.AXIOM_ERROR = Kernel.AXIOM_ERROR;
module.exports.CONTRACT_VERSION = Kernel.CONTRACT_VERSION;
module.exports.ProvenanceError = Kernel.ProvenanceError;
module.exports.createAdmissionBypassOpts = Kernel.createAdmissionBypassOpts;

// #657: general Error Prevention core. Callers can bind it to the canonical
// kernel memory store (`createErrorPrevention(kernel.memory)`) from SDK, API,
// CLI, MCP, or any other host without coupling the core to a specific agent.
module.exports.ErrorPrevention = errorPrevention.ErrorPrevention;
module.exports.createErrorPrevention = errorPrevention.createErrorPrevention;
module.exports.errorPrevention = errorPrevention;

// Agent Action Firewall public surface. The runtime seams use the same module,
// so SDK/connector hosts can preflight an action without creating a second policy.
module.exports.AgentActionFirewall = agentActionFirewall;
module.exports.evaluateAgentActionFirewall = agentActionFirewall.evaluateAgentActionFirewall;
module.exports.AGENT_ACTION_FIREWALL_VERSION = agentActionFirewall.AGENT_ACTION_FIREWALL_VERSION;
module.exports.AGENT_ACTION_FIREWALL_DECISIONS = agentActionFirewall.AGENT_ACTION_FIREWALL_DECISIONS;
