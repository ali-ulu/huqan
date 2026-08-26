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
const agentIdentityRuntime = require('./lib/agent-identity-runtime');
const trustEvidenceLedger = require('./lib/trust-evidence-ledger');
const humanOversightApprovalRuntime = require('./lib/human-oversight-approval-runtime');
const prGuardian = require('./lib/pr-guardian');
const multiAgentCascadeGuard = require('./lib/multi-agent-cascade-guard');
const trustReceiptPilot = require('./lib/pilot/trust-receipt-pilot');
const trustReceiptPilotArchive = require('./lib/pilot/trust-receipt-pilot-archive');
const pilotTestDatabaseBoundary = require('./lib/pilot/test-database-boundary');

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

// Runtime agent identity and delegated-authority surface. Hosts may compose this
// evaluator into mutation admission without creating a second identity policy.
module.exports.AgentIdentityRuntime = agentIdentityRuntime;
module.exports.evaluateAgentIdentity = agentIdentityRuntime.evaluateAgentIdentity;
module.exports.composeReceiverOwnedIdentityClaim = agentIdentityRuntime.composeReceiverOwnedIdentityClaim;
module.exports.snapshotAgentIdentityAuthority = agentIdentityRuntime.snapshotAgentIdentityAuthority;
module.exports.AGENT_IDENTITY_RUNTIME_VERSION = agentIdentityRuntime.AGENT_IDENTITY_RUNTIME_VERSION;
module.exports.IDENTITY_RUNTIME_ERRORS = agentIdentityRuntime.IDENTITY_RUNTIME_ERRORS;

// Durable Trust Evidence & Receipt Ledger surface. This composes the existing
// Graph mutation journal and receipt chain; it does not create a second trust root.
module.exports.TrustEvidenceLedger = trustEvidenceLedger;
module.exports.createTrustEvidenceLedger = trustEvidenceLedger.createTrustEvidenceLedger;
module.exports.buildTrustEvidencePayload = trustEvidenceLedger.buildTrustEvidencePayload;
module.exports.verifyTrustEvidenceReceipt = trustEvidenceLedger.verifyTrustEvidenceReceipt;
module.exports.TRUST_EVIDENCE_SCHEMA_VERSION = trustEvidenceLedger.TRUST_EVIDENCE_SCHEMA_VERSION;

// Human Oversight & Approval Runtime. The factory requires receiver-owned
// identity resolution, the existing Graph mutation journal, and the existing
// Trust Evidence Ledger; it does not create a second durability authority.
module.exports.HumanOversightApprovalRuntime = humanOversightApprovalRuntime;
module.exports.createHumanOversightApprovalRuntime = humanOversightApprovalRuntime.createHumanOversightApprovalRuntime;
module.exports.HUMAN_OVERSIGHT_RUNTIME_VERSION = humanOversightApprovalRuntime.HUMAN_OVERSIGHT_RUNTIME_VERSION;
module.exports.HUMAN_OVERSIGHT_RUNTIME_REASONS = humanOversightApprovalRuntime.RUNTIME_REASONS;

// GitHub PR Guardian SDK surface. It is transport-independent: hosts may use
// the library directly without MCP or the bundled HTTP server.
module.exports.PrGuardian = prGuardian;
module.exports.PRGuardian = prGuardian;

// Bounded multi-agent coordination. Hosts supply execution; this guard owns
// fan-out, dependency isolation, retry, and circuit-breaker policy.
module.exports.MultiAgentCascadeGuard = multiAgentCascadeGuard;
module.exports.createMultiAgentCascadeGuard = multiAgentCascadeGuard.createMultiAgentCascadeGuard;
module.exports.MULTI_AGENT_CASCADE_REASONS = multiAgentCascadeGuard.REASONS;

// Bounded Trust Receipt pilot surface for one real issuer-to-receiver event.
module.exports.TrustReceiptPilot = trustReceiptPilot;
module.exports.buildPilotTrustReceipt = trustReceiptPilot.buildPilotTrustReceipt;
module.exports.projectPilotTrustReceipt = trustReceiptPilot.projectPilotTrustReceipt;
module.exports.verifyPilotTrustReceipt = trustReceiptPilot.verifyPilotTrustReceipt;
module.exports.verifyPilotPublicProjection = trustReceiptPilot.verifyPilotPublicProjection;
module.exports.createPilotReceiptArchive = trustReceiptPilotArchive.createPilotReceiptArchive;
module.exports.assertPilotTestDatabaseBoundary = pilotTestDatabaseBoundary.assertPilotTestDatabaseBoundary;
