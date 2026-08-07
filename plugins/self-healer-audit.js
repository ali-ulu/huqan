'use strict';

const { analyzeReachability } = require('../lib/module-reachability');
const { runSelfHealerDryRun } = require('../lib/self-healer/dryrun-runner');
const { simulateSourceCandidate } = require('../lib/self-healer/source-dogfood-simulator');

function ensureAuditState(kernel) {
  if (!kernel._selfHealerAuditState) kernel._selfHealerAuditState = { iterationsUsed: 0 };
  return kernel._selfHealerAuditState;
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
  const auditState = ensureAuditState(kernel);
  const result = runSelfHealerDryRun(
    { findings, workspaceId, iterationsUsed: auditState.iterationsUsed },
    { maxIterationsPerWindow: options.maxIterationsPerWindow },
  );
  if (!result.blockedByBudget) auditState.iterationsUsed += findings.length || 1;
  return result;
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
    description: 'Runs governed Self-Healer audit and source-simulation flows.',
  }],
  run(kernel, input = {}) {
    const action = String(input.action || 'scan').toLowerCase();
    if (action === 'scan') {
      try { return runReachabilityAudit(kernel, input); } catch (error) { return failure(error); }
    }
    if (action === 'simulate') return runSourceSimulation(kernel, input).catch(failure);
    return { ok: false, error: `Unsupported self-healer-audit action: ${action}` };
  },
};

module.exports._test = {
  ensureAuditState,
  unclassifiedModuleFinding,
  governFindings,
  runReachabilityAudit,
  runSourceSimulation,
};
