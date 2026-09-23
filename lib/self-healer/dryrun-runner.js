'use strict';

/**
 * Self-Healer dry-run runner.
 *
 * This is the missing link between the audit surface that already exists
 * (`audit-runner.js` produces findings, `finding-classifier.js` shapes raw
 * ones) and the trust layer that already exists (AB10 loop budget, approval
 * flow, receipts). Before this module, findings had nowhere to go: nothing
 * turned a finding into a governed, receipt-bearing proposal that a human has
 * to decide on.
 *
 *     findings -> AB10 budget -> safety decision -> proposal
 *              -> approval request -> trust receipt summary
 *
 * This module is the orchestration only: it normalizes the input findings,
 * builds the deterministic run context, applies the AB10 gate, and freezes
 * the result. The durable projections (approval payload, receipt summary,
 * run id) live in `dryrun-projections.js`; the AB10 loop-budget arithmetic
 * lives in `dryrun-budget-gate.js`. The code was moved, not rewritten.
 *
 * What it deliberately does NOT do, and why:
 *
 * - **It never applies anything.** `applied` is `false` on every path and the
 *   result is frozen. `docs/self-healer-safety-matrix.md` blocks auto-merge
 *   outright and puts runtime code patches behind `require_review`.
 *
 * - **It never generates a code patch.** `finding-schema.js`'s `suggestedFix`
 *   carries `{summary, allowedFiles, forbiddenFiles, risk}` and has no field
 *   for patch content. Adding patch text to the approval payload would put
 *   unreviewed generated code into the durable approval record.
 *
 * - **It never runs tests.** The safety matrix rates test execution as
 *   `require_review` ("açık izin olmadan test koşulmaz"). Test *proposals*
 *   ride along on the finding as `suggestedTests`.
 *
 * - **It does not use `dream.js`, `sandboxRunner.js` or `rustGraph.js`.**
 *   `Dream.dream()` generates hypotheses over knowledge-graph nodes
 *   (`this.graph._nodes`); it does not read source files and cannot produce a
 *   code change. `sandboxRunner` is a `node:vm` evaluator that forbids
 *   `require`, `fs`, `process` and `module`, so it structurally cannot load
 *   the real codebase to test a candidate against it. `rustGraph` is a graph
 *   backend, not a code simulator. Wiring them in would produce the shape of
 *   a dogfood loop without the substance.
 */

const {
  SELF_HEALER_DRYRUN_VERSION,
  SELF_HEALER_DRYRUN_MODE,
  RISK_SCORE_BY_SEVERITY,
  buildReceiptSummary,
  buildProposalApprovalRequest,
  createRunId,
} = require('./dryrun-projections');
const { evaluateDryRunBudget } = require('./dryrun-budget-gate');
const { normalizeFinding } = require('./finding-schema');
const { decideSelfHealerAction } = require('./safety-decision');

const { isPlainObject } = require('../is-plain-object');

const DEFAULT_AGENT_ID = 'self-healer';
const DEFAULT_ACTOR = 'self-healer';
const DEFAULT_OWNER = 'human_reviewer';

function normalizeString(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

/**
 * Runs one dry-run pass over a set of findings.
 *
 * @param {object} input
 * @param {object[]} input.findings findings, or an audit report's `findings`
 * @param {number} [input.iterationsUsed] iterations already spent by this
 *   workspace in the current AB10 window
 * @param {object} [opts]
 * @param {string} [opts.workspaceId]
 * @param {string} [opts.actor] who is requesting (not who approves)
 * @param {string} [opts.owner] the human who must decide
 * @param {string} [opts.createdAt]
 * @param {number} [opts.maxIterationsPerWindow] AB10 override
 * @returns {object} frozen run result; `applied` is always false
 */
function runSelfHealerDryRun(input = {}, opts = {}) {
  const source = isPlainObject(input) ? input : {};
  const options = isPlainObject(opts) ? opts : {};

  const workspaceId = normalizeString(source.workspaceId ?? options.workspaceId, 'default');
  const createdAt = normalizeString(options.createdAt, new Date().toISOString());
  const rawFindings = Array.isArray(source.findings) ? source.findings : [];

  const findings = rawFindings.map((finding) => normalizeFinding(finding, { workspaceId }));

  const context = {
    runId: createRunId({
      version: SELF_HEALER_DRYRUN_VERSION,
      workspaceId,
      findingIds: findings.map((finding) => finding.findingId).sort(),
    }),
    workspaceId,
    createdAt,
    agentId: normalizeString(options.agentId, DEFAULT_AGENT_ID),
    actor: normalizeString(options.actor, DEFAULT_ACTOR),
    owner: normalizeString(options.owner, DEFAULT_OWNER),
  };

  // AB10 first: a workspace that has burned through its loop budget does not
  // get to generate more proposals, however safe those proposals would be.
  // This is the runaway-loop stop, so it runs before any finding is examined.
  // `budgetUsageKnown: false` is how an unmeasured caller stays
  // distinguishable from a genuinely fresh workspace; see dryrun-budget-gate.
  const gate = evaluateDryRunBudget({
    findingCount: findings.length,
    iterationsUsed: source.iterationsUsed,
    maxIterationsPerWindow: options.maxIterationsPerWindow,
  });

  if (gate.blocked) {
    return Object.freeze({
      ok: true,
      version: SELF_HEALER_DRYRUN_VERSION,
      mode: SELF_HEALER_DRYRUN_MODE,
      runId: context.runId,
      workspaceId,
      applied: false,
      blockedByBudget: true,
      budgetReviewRequired: false,
      budgetTruncated: false,
      budget: gate.budget,
      budgetUsageKnown: gate.usageKnown,
      findingCount: findings.length,
      processedFindingCount: 0,
      proposals: Object.freeze([]),
      summary: Object.freeze({
        observe: 0, propose: 0, require_review: 0, block: 0, quarantine: 0,
        approvalsRequired: 0,
      }),
      createdAt,
    });
  }

  const findingsToProcess = findings.slice(0, gate.processCount);

  const summary = {
    observe: 0, propose: 0, require_review: 0, block: 0, quarantine: 0,
    approvalsRequired: 0,
  };

  const proposals = findingsToProcess.map((finding) => {
    const decisionResult = decideSelfHealerAction(finding);
    summary[decisionResult.decision] += 1;
    if (decisionResult.requiresApproval) summary.approvalsRequired += 1;

    const approval = buildProposalApprovalRequest(finding, decisionResult, context);

    return Object.freeze({
      findingId: finding.findingId,
      kind: finding.kind,
      severity: finding.severity,
      decision: decisionResult.decision,
      reason: decisionResult.reason,
      requiresApproval: decisionResult.requiresApproval,
      allowedNextSteps: Object.freeze([...decisionResult.allowedNextSteps]),
      applied: false,
      approvalRequest: approval && approval.ok ? Object.freeze(approval.request) : null,
      approvalErrors: approval && !approval.ok ? Object.freeze(approval.errors) : null,
      receiptSummary: Object.freeze(buildReceiptSummary(finding, decisionResult, context)),
    });
  });

  return Object.freeze({
    ok: true,
    version: SELF_HEALER_DRYRUN_VERSION,
    mode: SELF_HEALER_DRYRUN_MODE,
    runId: context.runId,
    workspaceId,
    applied: false,
    blockedByBudget: false,
    budgetReviewRequired: gate.budgetReviewRequired,
    budgetTruncated: gate.budgetTruncated,
    budget: gate.budget,
    budgetUsageKnown: gate.usageKnown,
    findingCount: findings.length,
    processedFindingCount: findingsToProcess.length,
    proposals: Object.freeze(proposals),
    summary: Object.freeze(summary),
    createdAt,
  });
}

module.exports = {
  SELF_HEALER_DRYRUN_VERSION,
  SELF_HEALER_DRYRUN_MODE,
  RISK_SCORE_BY_SEVERITY,
  runSelfHealerDryRun,
};
