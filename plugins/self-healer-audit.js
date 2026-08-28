'use strict';

const { analyzeReachability } = require('../lib/module-reachability');
const { runSelfHealerDryRun } = require('../lib/self-healer/dryrun-runner');
const { runSelfHealerAudit } = require('../lib/self-healer/audit-runner');
const { classifyRawFinding } = require('../lib/self-healer/finding-classifier');
const { createSelfHealerApprovalBridge } = require('../lib/self-healer/approval-bridge');
const { simulateSourceCandidate } = require('../lib/self-healer/source-dogfood-simulator');
const {
  assessBehavior,
  createBehavioralBaseline,
} = require('../lib/self-healer/behavioral-containment');
const { DEFAULT_WINDOW_MS } = require('../lib/agent-loop-budget-gate');

/**
 * AB10's ceiling is per workspace and per time window. This counter was
 * neither: one number on the kernel that only ever grew.
 *
 * Without a window it behaved like "200 iterations for the lifetime of the
 * process" rather than a rolling hour -- once spent, auditing was blocked
 * permanently and waiting did not help, because nothing read the clock.
 * Without a workspace, one tenant's audit volume consumed another tenant's
 * budget, which is the thing a workspace-scoped ceiling exists to prevent.
 *
 * Usage is kept as timestamped entries per workspace, mirroring how agent.v3.js
 * reads its own budget (`sumAgentIterationsSince(workspaceId, now - windowMs)`)
 * -- in memory rather than durable, so a restart still clears it. Durability
 * would mean writing usage to the store, and that is a larger change than the
 * counter this issue is about.
 */
function ensureAuditState(kernel) {
  if (!kernel._selfHealerAuditState || !(kernel._selfHealerAuditState.byWorkspace instanceof Map)) {
    kernel._selfHealerAuditState = { byWorkspace: new Map() };
  }
  return kernel._selfHealerAuditState;
}

/**
 * Iterations spent in this workspace inside the current window, dropping the
 * entries that have aged out.
 *
 * @param {object} kernel
 * @param {string} workspaceId
 * @param {number} windowMs
 * @param {number} now
 * @returns {number}
 */
function iterationsUsedInWindow(kernel, workspaceId, windowMs, now) {
  const state = ensureAuditState(kernel);
  const since = now - windowMs;
  const kept = (state.byWorkspace.get(workspaceId) || []).filter((entry) => entry.at > since);
  state.byWorkspace.set(workspaceId, kept);
  return kept.reduce((total, entry) => total + entry.count, 0);
}

function recordIterations(kernel, workspaceId, count, now) {
  const state = ensureAuditState(kernel);
  const entries = state.byWorkspace.get(workspaceId) || [];
  entries.push({ at: now, count });
  state.byWorkspace.set(workspaceId, entries);
}

function unclassifiedModuleFinding(relPath, workspaceId) {
  return {
    kind: 'release_hygiene',
    severity: 'low',
    title: `Unclassified unreachable module: ${relPath}`,
    summary: `${relPath} is not reachable from any production entry point (cli.js/server.js/mcpServer.js/kernel.js) and is not classified in lib/module-reachability.js's NOT_YET_WIRED or standalone lists.`,
    evidence: [{ type: 'file', ref: relPath, detail: 'unreachable from production entry points and unclassified' }],
    affectedFiles: [relPath],
    suggestedFix: {
      summary: 'Wire the module up to a production entry point, or add it to NOT_YET_WIRED in lib/module-reachability.js with a stated reason.',
      allowedFiles: [relPath, 'lib/module-reachability.js'],
      forbiddenFiles: [],
      risk: 'low',
    },
    workspaceId,
  };
}

function governFindings(kernel, findings, options = {}) {
  const workspaceId = options.workspaceId || 'default';
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : DEFAULT_WINDOW_MS;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const repoRoot = options.repoRoot || options.root || process.cwd();
  const classifiedFindings = findings.map((finding) => classifyRawFinding(finding, { workspaceId }));
  const auditReport = runSelfHealerAudit({
    workspaceId,
    repoRoot,
    mode: 'audit_only',
    checks: classifiedFindings,
  });
  const result = runSelfHealerDryRun(
    {
      findings: auditReport.findings,
      workspaceId,
      iterationsUsed: iterationsUsedInWindow(kernel, workspaceId, windowMs, now),
    },
    { maxIterationsPerWindow: options.maxIterationsPerWindow },
  );
  if (!result.blockedByBudget) recordIterations(kernel, workspaceId, findings.length || 1, now);
  const approvalBridge = createSelfHealerApprovalBridge({
    approvalRuntime: options.approvalRuntime,
    requesterContext: options.requesterContext,
    resolveFirewall: options.resolveFirewall,
  });
  const approvalResult = approvalBridge.bridge({
    proposals: result.proposals,
    findings: auditReport.findings,
    workspaceId,
    runId: result.runId,
    auditReportId: auditReport.reportId,
  });
  return {
    ...result,
    auditReport,
    auditReportId: auditReport.reportId,
    approvalBridge: approvalResult,
  };
}

function runBehavioralObservation(kernel, options = {}) {
  const workspaceId = options.workspaceId || 'default';
  const baselineInput = options.baseline && typeof options.baseline === 'object' ? options.baseline : {};
  const observationInput = options.observation && typeof options.observation === 'object' ? options.observation : {};
  const baseline = createBehavioralBaseline({ ...baselineInput, workspaceId });
  const behavior = assessBehavior({
    baseline,
    observation: { ...observationInput, workspaceId },
  }, options);
  const governed = governFindings(kernel, behavior.finding ? [behavior.finding] : [], options);
  return {
    ...governed,
    ok: behavior.ok,
    action: 'behavior',
    behavior,
    containment: behavior.containment,
    receiptSummary: behavior.receiptSummary,
    applied: false,
  };
}

function runReachabilityAudit(kernel, options = {}) {
  const workspaceId = options.workspaceId || 'default';
  const analysis = analyzeReachability(options.root ? { root: options.root } : {});
  const findings = analysis.unacknowledged.map((relPath) => unclassifiedModuleFinding(relPath, workspaceId));
  return { ...governFindings(kernel, findings, options), unacknowledgedCount: findings.length };
}

async function runSourceSimulation(kernel, options = {}) {
  const simulation = await simulateSourceCandidate(options);
  if (!simulation.candidate) {
    return { ...simulation, findingCount: 0, proposals: [], blockedByBudget: false };
  }
  return { ...governFindings(kernel, [simulation.finding], options), simulation };
}

function failure(error) {
  return {
    ok: false,
    error: error && error.message ? error.message : 'Self-Healer audit failed',
    code: error && error.code ? error.code : 'SELF_HEALER_AUDIT_FAILED',
  };
}

module.exports = {
  name: 'self-healer-audit',
  requires: [],
  optional: [],
  capabilities: [{
    name: 'selfHealerAudit',
    command: 'self-healer-audit',
    description: 'Runs governed Self-Healer audit, behavior-observation, and source-simulation flows.',
  }],
  run(kernel, input = {}) {
    const action = String(input.action || 'scan').toLowerCase();
    if (action === 'scan') {
      try { return runReachabilityAudit(kernel, input); } catch (error) { return failure(error); }
    }
    if (action === 'behavior') {
      try { return runBehavioralObservation(kernel, input); } catch (error) { return failure(error); }
    }
    if (action === 'simulate') return runSourceSimulation(kernel, input).catch(failure);
    return { ok: false, error: `Unsupported self-healer-audit action: ${action}` };
  },
};

module.exports._test = {
  ensureAuditState,
  unclassifiedModuleFinding,
  governFindings,
  runBehavioralObservation,
  runReachabilityAudit,
  runSourceSimulation,
};
