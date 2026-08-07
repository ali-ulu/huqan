'use strict';

/**
 * self-healer-audit (#224 follow-up).
 *
 * lib/self-healer/{audit-runner,dryrun-runner}.js already implement the
 * gate/approval/receipt half of #224's dogfood loop, and were merged
 * library-only, no production caller (the issue's own closing comment:
 * dream.js/sandboxRunner.js/rustGraph.js structurally cannot generate or
 * sandbox a real code-change candidate without a separate, larger security
 * decision -- relaxing sandboxRunner's require/fs ban, or a new code-
 * reading proposal generator that isn't dream). That decision is NOT made
 * here.
 *
 * What audit-runner.js/dryrun-runner.js were still missing is any actual
 * finding source: runSelfHealerAudit()/runSelfHealerDryRun() both just
 * accept a `findings` array as input and govern it -- nothing fed them
 * one, so the pipeline had inputs and outputs but no wiring in between.
 * lib/module-reachability.js's "unclassified unreachable module" list is
 * used here as that source because it needs no new capability at all:
 * deterministic, already computed by an existing tested module, read-only
 * (touches no files, runs no code, generates no patch).
 *
 * Exposed as a capability (kernel.runCapability), not a CLI-only command,
 * so it's reachable identically from CLI, MCP, or server -- the same
 * pattern every other plugin in this repo uses, and the reason a CLI-only
 * command was deliberately not built instead.
 *
 * Every proposal this produces has applied: false (guaranteed by
 * runSelfHealerDryRun() itself, not re-enforced here) and a receipt/
 * approval-request pair a human reviews through the existing onayla:/
 * axiom.approve flow -- this plugin adds no path that bypasses that.
 */

const { analyzeReachability } = require('../lib/module-reachability');
const { runSelfHealerDryRun } = require('../lib/self-healer/dryrun-runner');

function ensureAuditState(kernel) {
  if (!kernel._selfHealerAuditState) {
    kernel._selfHealerAuditState = { iterationsUsed: 0 };
  }
  return kernel._selfHealerAuditState;
}

function unclassifiedModuleFinding(relPath, workspaceId) {
  return {
    kind: 'release_hygiene',
    severity: 'low',
    title: `Unclassified unreachable module: ${relPath}`,
    summary: `${relPath} is not reachable from any production entry point (cli.js/server.js/mcpServer.js/kernel.js) and is not classified in lib/module-reachability.js's NOT_YET_WIRED or standalone lists.`,
    evidence: [{
      type: 'file',
      ref: relPath,
      detail: 'unreachable from production entry points and unclassified',
    }],
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

function runReachabilityAudit(kernel, options = {}) {
  const workspaceId = options.workspaceId || 'default';
  const analysis = analyzeReachability(options.root ? { root: options.root } : {});
  const findings = analysis.unacknowledged.map((relPath) => unclassifiedModuleFinding(relPath, workspaceId));

  const auditState = ensureAuditState(kernel);
  const result = runSelfHealerDryRun(
    { findings, workspaceId, iterationsUsed: auditState.iterationsUsed },
    { maxIterationsPerWindow: options.maxIterationsPerWindow }
  );
  if (!result.blockedByBudget) {
    auditState.iterationsUsed += findings.length || 1;
  }
  return { ...result, unacknowledgedCount: findings.length };
}

module.exports = {
  name: 'self-healer-audit',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'selfHealerAudit',
      command: 'self-healer-audit',
      description: 'Runs lib/module-reachability.js\'s unclassified-module findings through the self-healer dry-run pipeline (gate + approval + receipt). Never applies anything.',
    },
  ],

  run(kernel, input = {}) {
    const action = String(input.action || 'scan').toLowerCase();
    if (action === 'scan') {
      try {
        return runReachabilityAudit(kernel, input);
      } catch (e) {
        return { ok: false, error: e.message, code: e.code || 'SELF_HEALER_AUDIT_FAILED' };
      }
    }
    return { ok: false, error: `Unsupported self-healer-audit action: ${action}` };
  },
};

module.exports._test = { ensureAuditState, unclassifiedModuleFinding, runReachabilityAudit };
