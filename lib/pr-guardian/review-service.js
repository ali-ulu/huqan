'use strict';

const crypto = require('node:crypto');
const { evaluatePullRequest, ACTIONS, DECISIONS } = require('./policy');
const { normalizePullRequestSnapshot, sameTarget } = require('./snapshot');
const { projectApprovalRecord } = require('../mcp-approval-views');

const TOOL = 'github.pr.guardian';

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

function nowMs() {
  return Date.now();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return '{}'; }
}

function makeReceipt({ approval, snapshot, action, outcome, result = null, error = null }) {
  const issuedAt = new Date().toISOString();
  const receiptId = `ghreceipt_${sha256(`${approval.id}|${snapshot.targetHash}|${action}|${outcome}|${issuedAt}`).slice(0, 24)}`;
  return Object.freeze({
    receiptId,
    type: 'huqan.github.pr.guardian.execution',
    version: '1.0.0',
    approvalId: approval.id,
    workspaceId: snapshot.workspaceId,
    repo: snapshot.repo,
    pullRequest: snapshot.number,
    headSha: snapshot.headSha,
    targetHash: snapshot.targetHash,
    action,
    outcome,
    issuedAt,
    resultHash: result == null ? null : `sha256:${sha256(safeJson(result))}`,
    errorCode: error?.code || null,
    canonicalWrite: false,
  });
}

function publicApproval(record) {
  return projectApprovalRecord(record);
}

function createReviewService({ storage, kernel = null, getCurrentSnapshot = null, now = nowMs } = {}) {
  if (!storage || typeof storage.saveToolApprovalIfAbsent !== 'function') {
    throw new TypeError('storage with saveToolApprovalIfAbsent is required');
  }

  function list(limit = 50, workspaceId = 'default') {
    const rows = typeof storage.listUnresolvedToolApprovals === 'function'
      ? storage.listUnresolvedToolApprovals(Math.min(100, Math.max(1, Number(limit) || 50)), text(workspaceId) || 'default')
      : [];
    return rows.filter(row => row.tool === TOOL).map(publicApproval);
  }

  function get(id, workspaceId = 'default') {
    if (typeof storage.getToolApprovalById !== 'function') return null;
    const row = storage.getToolApprovalById(id, text(workspaceId) || 'default');
    return row && row.tool === TOOL ? publicApproval(row) : null;
  }

  function enqueue(snapshotInput, { action = ACTIONS.COMMENT_CREATE, requestedBy = 'github-webhook' } = {}) {
    const snapshot = normalizePullRequestSnapshot(snapshotInput);
    const policy = evaluatePullRequest(snapshot, { action, phase: 'preview' });
    const approvalKey = `${TOOL}|${snapshot.workspaceId}|${snapshot.repo}|${snapshot.number}|${snapshot.headSha}|${action}`;
    const saved = storage.saveToolApprovalIfAbsent({
      id: `ghapproval_${sha256(approvalKey).slice(0, 24)}`,
      approvalKey,
      tool: TOOL,
      input: JSON.stringify({ action, repo: snapshot.repo, number: snapshot.number, headSha: snapshot.headSha }),
      status: policy.decision === DECISIONS.BLOCK ? 'rejected' : 'pending',
      decision: policy.decision,
      reason: policy.reason,
      context: {
        source: 'github-pr-guardian',
        requestedBy,
        snapshot,
        action,
        targetHash: snapshot.targetHash,
        provenance: snapshot.provenance,
        riskLabels: policy.riskLabels,
      },
      policy,
    });
    const approval = saved.approval;
    return {
      ok: policy.decision !== DECISIONS.BLOCK,
      idempotent: !saved.inserted,
      decision: policy.decision,
      policy,
      approval: approval ? publicApproval(approval) : null,
      snapshot,
    };
  }

  function decide(id, decision, reason = '', workspaceId = 'default') {
    const scopedWorkspaceId = text(workspaceId) || 'default';
    const record = storage.getToolApprovalById(id, scopedWorkspaceId);
    if (!record || record.tool !== TOOL) return { ok: false, status: 404, code: 'PR_APPROVAL_NOT_FOUND' };
    if (!['approved', 'rejected'].includes(decision)) return { ok: false, status: 400, code: 'PR_DECISION_INVALID' };
    const updated = decision === 'approved'
      ? storage.resolveToolApproval(id, 'approved', reason || 'operator_approved', scopedWorkspaceId)
      : storage.rejectToolApproval(id, reason || 'operator_rejected', scopedWorkspaceId);
    return {
      ok: true,
      decision,
      approval: updated ? publicApproval(updated) : null,
    };
  }

  /**
   * Execute an approved action exactly once (#1675).
   *
   * The GitHub call in the middle of this function is an external side effect
   * that cannot be undone: posting a comment twice is two comments. The
   * approval used to stay `approved` for the whole call and afterwards, so
   * every repeated submit -- an impatient operator, a retried HTTP request, a
   * second worker handling the same webhook -- ran it again.
   *
   * The order below is what makes it once:
   *
   *   1. Everything that can refuse without touching GitHub (approval state,
   *      operator token, snapshot freshness, policy, an executable action and
   *      a client that can perform it) runs first, so a refusal never spends
   *      the approval.
   *   2. The approval is claimed into `executing` atomically. Losing that
   *      claim -- to a concurrent executor or to a previous run -- ends the
   *      request here, before the call.
   *   3. Only then is the action performed, and the terminal state is written
   *      explicitly: `execution` in the context on success, `failed` with
   *      `execution_outcome_unknown` when the call threw.
   *
   * A thrown call is deliberately *not* returned to `approved`. The comment
   * may or may not have been posted; re-running an action whose outcome is
   * unknown is how the duplicate this issue is about gets created. The row is
   * left `failed` for reconciliation, and a genuine retry means a fresh
   * approval.
   */
  async function execute(id, { action, body, githubClient = null, operatorToken = '', workspaceId = 'default' } = {}) {
    const scopedWorkspaceId = text(workspaceId) || 'default';
    const record = storage.getToolApprovalById(id, scopedWorkspaceId);
    if (!record || record.tool !== TOOL) return { ok: false, status: 404, code: 'PR_APPROVAL_NOT_FOUND' };
    if (record.status === 'executing') {
      // Another executor holds the claim. Named separately from
      // PR_APPROVAL_REQUIRED so an operator can tell "nobody approved this"
      // from "someone is running it right now".
      return { ok: false, status: 409, code: 'PR_EXECUTION_IN_PROGRESS', decision: DECISIONS.BLOCK, approval: publicApproval(record) };
    }
    if (record.status !== 'approved' || record.decision !== 'approved') {
      return { ok: false, status: 409, code: 'PR_APPROVAL_REQUIRED', decision: DECISIONS.REVIEW, approval: publicApproval(record) };
    }
    if (record.context?.execution) {
      // Already run to completion. Answering with the stored receipt rather
      // than a bare error keeps a retried HTTP request idempotent from the
      // caller's side, without performing the action a second time.
      return {
        ok: false,
        status: 409,
        code: 'PR_ALREADY_EXECUTED',
        decision: DECISIONS.BLOCK,
        receipt: record.context.receipt || null,
        approval: publicApproval(record),
      };
    }
    if (!text(operatorToken)) {
      return { ok: false, status: 503, code: 'PR_OPERATOR_TOKEN_REQUIRED' };
    }
    if (typeof storage.claimApprovedToolApproval !== 'function') {
      // Fail closed: without an atomic claim there is no way to promise the
      // action runs once, and running it anyway is the bug.
      return { ok: false, status: 503, code: 'PR_EXECUTION_CLAIM_UNAVAILABLE', decision: DECISIONS.BLOCK, approval: publicApproval(record) };
    }

    const storedSnapshot = record.context?.snapshot;
    let currentSnapshot = storedSnapshot;
    if (typeof getCurrentSnapshot === 'function') {
      currentSnapshot = normalizePullRequestSnapshot(await getCurrentSnapshot(storedSnapshot));
    }
    if (!sameTarget(storedSnapshot, currentSnapshot)) {
      return { ok: false, status: 409, code: 'PR_SNAPSHOT_STALE', decision: DECISIONS.BLOCK, approval: publicApproval(record) };
    }

    const requestedAction = text(action || record.context?.action || ACTIONS.COMMENT_CREATE);
    const preflight = evaluatePullRequest(currentSnapshot, {
      action: requestedAction,
      phase: 'execute',
      approved: true,
    });
    if (preflight.decision !== DECISIONS.ALLOW) {
      return { ok: false, status: 409, code: `PR_EXECUTION_${preflight.decision.toUpperCase()}`, decision: preflight.decision, policy: preflight, approval: publicApproval(record) };
    }

    const client = githubClient;
    if (!client) return { ok: false, status: 503, code: 'GITHUB_EXECUTOR_UNAVAILABLE', decision: DECISIONS.BLOCK, approval: publicApproval(record) };

    // Decided before the claim so an action this service cannot perform is
    // refused without consuming the approval.
    if (requestedAction === ACTIONS.STATUS_PREVIEW) {
      return { ok: false, status: 409, code: 'PR_STATUS_IS_PREVIEW_ONLY', decision: DECISIONS.DRY_RUN_ONLY, approval: publicApproval(record) };
    }
    if (requestedAction !== ACTIONS.COMMENT_CREATE || typeof client.createComment !== 'function') {
      return { ok: false, status: 409, code: 'PR_ACTION_NOT_EXECUTABLE', decision: DECISIONS.BLOCK, approval: publicApproval(record) };
    }

    const claim = storage.claimApprovedToolApproval(record.id, {
      owner: `pr-guardian:${requestedAction}`,
      reason: 'pr_guardian_execution_claimed',
      workspaceId: scopedWorkspaceId,
    });
    if (!claim || claim.claimed !== true) {
      const latest = claim?.approval || record;
      const alreadyDone = Boolean(latest.context?.execution);
      return {
        ok: false,
        status: 409,
        code: alreadyDone ? 'PR_ALREADY_EXECUTED' : 'PR_EXECUTION_IN_PROGRESS',
        decision: DECISIONS.BLOCK,
        receipt: alreadyDone ? latest.context?.receipt || null : null,
        approval: publicApproval(latest),
      };
    }
    const claimed = claim.approval || record;

    let result;
    try {
      result = await client.createComment(currentSnapshot.repo, currentSnapshot.number, body || `HUQAN Review Console approval: ${currentSnapshot.targetHash}`);
    } catch (error) {
      const failed = typeof storage.failToolApproval === 'function'
        ? storage.failToolApproval(record.id, `github_executor_failed:${error.code || 'unknown'}`, scopedWorkspaceId)
        : claimed;
      const receipt = makeReceipt({ approval: record, snapshot: currentSnapshot, action: requestedAction, outcome: 'outcome_unknown', error });
      return { ok: false, status: 502, code: 'GITHUB_EXECUTOR_FAILED', decision: DECISIONS.BLOCK, error: error.code || error.message, receipt, approval: failed ? publicApproval(failed.approval || failed) : publicApproval(claimed) };
    }

    const receipt = makeReceipt({ approval: record, snapshot: currentSnapshot, action: requestedAction, outcome: 'completed', result });
    const execution = { action: requestedAction, completedAt: now(), outcome: 'completed' };
    const finalized = typeof storage.finalizeToolApprovalWithReceipt === 'function'
      ? storage.finalizeToolApprovalWithReceipt(record.id, {
          expectedStatus: 'executing',
          decision: 'approved',
          reason: 'pr_guardian_execution_completed',
          receipt,
          contextPatch: { execution },
          workspaceId: scopedWorkspaceId,
        })
      : null;
    const persisted = finalized?.approval
      || (typeof storage.getToolApprovalById === 'function' ? storage.getToolApprovalById(record.id, scopedWorkspaceId) : claimed);
    return { ok: true, status: 200, decision: DECISIONS.ALLOW, result, receipt, approval: publicApproval(persisted || claimed) };
  }

  function dryRun(snapshotInput, { action = ACTIONS.STATUS_PREVIEW } = {}) {
    const snapshot = normalizePullRequestSnapshot(snapshotInput);
    const policy = evaluatePullRequest(snapshot, { action, phase: 'preview' });
    return { ok: true, dryRun: true, decision: policy.decision, policy, snapshot, canonicalWrite: false };
  }

  return Object.freeze({ list, get, enqueue, decide, execute, dryRun });
}

module.exports = Object.freeze({
  TOOL,
  createReviewService,
});
