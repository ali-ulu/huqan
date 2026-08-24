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

  async function execute(id, { action, body, githubClient = null, operatorToken = '', workspaceId = 'default' } = {}) {
    const scopedWorkspaceId = text(workspaceId) || 'default';
    const record = storage.getToolApprovalById(id, scopedWorkspaceId);
    if (!record || record.tool !== TOOL) return { ok: false, status: 404, code: 'PR_APPROVAL_NOT_FOUND' };
    if (record.status !== 'approved' || record.decision !== 'approved') {
      return { ok: false, status: 409, code: 'PR_APPROVAL_REQUIRED', decision: DECISIONS.REVIEW, approval: publicApproval(record) };
    }
    if (!text(operatorToken)) {
      return { ok: false, status: 503, code: 'PR_OPERATOR_TOKEN_REQUIRED' };
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

    let result;
    try {
      if (requestedAction === ACTIONS.COMMENT_CREATE && typeof client.createComment === 'function') {
        result = await client.createComment(currentSnapshot.repo, currentSnapshot.number, body || `HUQAN Review Console approval: ${currentSnapshot.targetHash}`);
      } else if (requestedAction === ACTIONS.STATUS_PREVIEW && typeof client.createStatus === 'function') {
        return { ok: false, status: 409, code: 'PR_STATUS_IS_PREVIEW_ONLY', decision: DECISIONS.DRY_RUN_ONLY, approval: publicApproval(record) };
      } else {
        return { ok: false, status: 409, code: 'PR_ACTION_NOT_EXECUTABLE', decision: DECISIONS.BLOCK, approval: publicApproval(record) };
      }
    } catch (error) {
      const failed = typeof storage.failToolApproval === 'function'
        ? storage.failToolApproval(id, `github_executor_failed:${error.code || 'unknown'}`, scopedWorkspaceId)
        : record;
      const receipt = makeReceipt({ approval: record, snapshot: currentSnapshot, action: requestedAction, outcome: 'outcome_unknown', error });
      return { ok: false, status: 502, code: 'GITHUB_EXECUTOR_FAILED', decision: DECISIONS.BLOCK, error: error.code || error.message, receipt, approval: failed ? publicApproval(failed.approval || failed) : publicApproval(record) };
    }

    const receipt = makeReceipt({ approval: record, snapshot: currentSnapshot, action: requestedAction, outcome: 'completed', result });
    const updatedContext = {
      ...(record.context || {}),
      receipt,
      execution: { action: requestedAction, completedAt: now(), outcome: 'completed' },
    };
    const persisted = typeof storage.saveToolApproval === 'function'
      ? storage.saveToolApproval({
          id: record.id,
          approvalKey: record.approval_key,
          tool: record.tool,
          input: record.input,
          status: record.status,
          decision: record.decision,
          reason: record.reason,
          context: updatedContext,
          policy: record.policy,
          createdAt: record.created_at,
          decidedAt: record.decided_at,
        })
      : record;
    return { ok: true, status: 200, decision: DECISIONS.ALLOW, result, receipt, approval: publicApproval(persisted || record) };
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
