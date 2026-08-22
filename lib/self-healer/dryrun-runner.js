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
 * The loop it closes is:
 *
 *     findings -> AB10 budget -> safety decision -> proposal
 *              -> approval request -> trust receipt summary
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

const crypto = require('node:crypto');

const { normalizeFinding } = require('./finding-schema');
const {
  SELF_HEALER_DECISIONS,
  decideSelfHealerAction,
} = require('./safety-decision');
const {
  AGENT_LOOP_BUDGET_DECISIONS,
  evaluateAgentLoopBudget,
} = require('../agent-loop-budget-gate');
const { buildApprovalRequest } = require('../approval-schema');

const SELF_HEALER_DRYRUN_VERSION = 'self-healer-dryrun-v0.1.0';
const SELF_HEALER_DRYRUN_MODE = 'dry_run';

const DEFAULT_AGENT_ID = 'self-healer';
const DEFAULT_ACTOR = 'self-healer';
const DEFAULT_OWNER = 'human_reviewer';
const APPROVAL_ACTION_TYPE = 'self_healer_proposal';
const APPROVAL_TOOL_NAME = 'self-healer.dryrun';

const RISK_SCORE_BY_SEVERITY = Object.freeze({
  info: 5,
  low: 25,
  medium: 50,
  high: 75,
  critical: 95,
});

const { isPlainObject } = require('../is-plain-object');

function normalizeString(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

/**
 * True only for a real, finite numeric usage figure. `null`, `undefined`,
 * `''` and `NaN` all coerce to 0 through `Number()`, which is exactly how a
 * missing measurement silently becomes "no budget spent" -- so they are
 * rejected here rather than coerced.
 */
function isFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function stableHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function riskScoreForSeverity(severity) {
  const key = normalizeString(severity).toLowerCase();
  return Object.prototype.hasOwnProperty.call(RISK_SCORE_BY_SEVERITY, key)
    ? RISK_SCORE_BY_SEVERITY[key]
    : RISK_SCORE_BY_SEVERITY.medium;
}

/**
 * `block` findings are refused outright, so they never become an approval
 * request. Everything else that needs a human is requested as `review` --
 * never `allow`, and never `dry_run_only`, because a self-proposed change
 * must not be able to describe itself as pre-authorized.
 */
function requestedVerdictFor(decision) {
  return decision === SELF_HEALER_DECISIONS.BLOCK ? 'block' : 'review';
}

/**
 * Copies only the fields that are safe to persist into a durable approval
 * record. This is an allowlist on purpose: it is what guarantees no patch
 * text, and no arbitrary caller-supplied field, reaches the approval store.
 */
function buildActionPayload(finding, decisionResult) {
  return {
    findingId: finding.findingId,
    kind: finding.kind,
    severity: finding.severity,
    title: finding.title,
    summary: finding.summary,
    affectedFiles: [...finding.affectedFiles],
    suggestedTests: [...finding.suggestedTests],
    suggestedFixSummary: normalizeString(finding.suggestedFix && finding.suggestedFix.summary),
    riskFlags: [...decisionResult.riskFlags],
    decision: decisionResult.decision,
    allowedNextSteps: [...decisionResult.allowedNextSteps],
    applied: false,
    patchIncluded: false,
  };
}

/**
 * Emits the `trust_receipt_summary` shape from
 * `docs/self-healer-contracts.md` section 7. This is explicitly a summary,
 * not a canonical Trust Receipt: it is not hash-chained and is not written
 * through the receipt chain. It records why a proposal was safe or blocked.
 */
function buildReceiptSummary(finding, decisionResult, context) {
  const payload = {
    version: SELF_HEALER_DRYRUN_VERSION,
    runId: context.runId,
    findingId: finding.findingId,
    decision: decisionResult.decision,
    reason: decisionResult.reason,
    workspaceId: context.workspaceId,
  };

  return {
    receiptId: `shr_${stableHash(payload).slice(0, 16)}`,
    receiptKind: 'self_healer_dryrun_summary',
    runId: context.runId,
    findingId: finding.findingId,
    decision: decisionResult.decision,
    reason: decisionResult.reason,
    evidenceSummary: {
      evidenceCount: finding.evidence.length,
      affectedFileCount: finding.affectedFiles.length,
      suggestedTestCount: finding.suggestedTests.length,
    },
    riskSummary: {
      severity: finding.severity,
      confidence: finding.confidence,
      riskFlags: [...decisionResult.riskFlags],
    },
    approvalRequired: decisionResult.requiresApproval,
    scopeSummary: {
      workspaceId: context.workspaceId,
      mode: SELF_HEALER_DRYRUN_MODE,
      applied: false,
    },
    policyVersion: SELF_HEALER_DRYRUN_VERSION,
    createdAt: context.createdAt,
  };
}

function buildProposalApprovalRequest(finding, decisionResult, context) {
  if (!decisionResult.requiresApproval) return null;

  const approvalId = `sha_${stableHash({
    runId: context.runId,
    findingId: finding.findingId,
    decision: decisionResult.decision,
  }).slice(0, 16)}`;

  const result = buildApprovalRequest({
    approvalId,
    workspaceId: context.workspaceId,
    agentId: context.agentId,
    actor: context.actor,
    owner: context.owner,
    actionType: APPROVAL_ACTION_TYPE,
    toolName: APPROVAL_TOOL_NAME,
    requestedVerdict: requestedVerdictFor(decisionResult.decision),
    reason: decisionResult.reason,
    // The finding is the provenance of the proposal: the proposal exists
    // because of that finding and nothing else.
    provenanceId: finding.findingId,
    trustPolicyVersion: SELF_HEALER_DRYRUN_VERSION,
    status: 'pending',
    riskScore: riskScoreForSeverity(finding.severity),
    createdAt: context.createdAt,
    actionPayload: buildActionPayload(finding, decisionResult),
  });

  return result;
}

function createRunId(input) {
  return `shrun_${stableHash(input).slice(0, 16)}`;
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
  //
  // `iterationsUsed` is supplied by the caller (this module owns no storage).
  // A caller that omits it gets a budget evaluated against zero usage, which
  // effectively disables the ceiling -- so that case is reported as
  // `budgetUsageKnown: false` rather than being indistinguishable from a
  // genuinely fresh workspace. The run is still allowed to proceed because it
  // has no side effects at all (`applied` is always false); what must not
  // happen is a consumer reading this result as budget-verified when no usage
  // was ever measured.
  const usageKnown = isFiniteNumber(source.iterationsUsed);
  const budget = evaluateAgentLoopBudget(
    {
      iterationsUsed: usageKnown ? Number(source.iterationsUsed) : 0,
      requestedIterations: findings.length || 1,
    },
    { maxIterationsPerWindow: options.maxIterationsPerWindow },
  );

  if (budget.decision === AGENT_LOOP_BUDGET_DECISIONS.BLOCK) {
    return Object.freeze({
      ok: true,
      version: SELF_HEALER_DRYRUN_VERSION,
      mode: SELF_HEALER_DRYRUN_MODE,
      runId: context.runId,
      workspaceId,
      applied: false,
      blockedByBudget: true,
      budget,
      budgetUsageKnown: usageKnown,
      findingCount: findings.length,
      proposals: Object.freeze([]),
      summary: Object.freeze({
        observe: 0, propose: 0, require_review: 0, block: 0, quarantine: 0,
        approvalsRequired: 0,
      }),
      createdAt,
    });
  }

  const summary = {
    observe: 0, propose: 0, require_review: 0, block: 0, quarantine: 0,
    approvalsRequired: 0,
  };

  const proposals = findings.map((finding) => {
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
    budget,
    budgetUsageKnown: usageKnown,
    findingCount: findings.length,
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
